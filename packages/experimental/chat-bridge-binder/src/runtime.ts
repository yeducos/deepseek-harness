/**
 * One binding's poll loop: long-poll the room through a dedicated connection,
 * wake the bound Session with the addressed messages, and commit the durable
 * cursor only after the Session persisted the delivery. Iteration failures
 * retry on a bounded exponential backoff; exhausting the budget gives up the
 * loop until the plugin reloads.
 *
 * @module
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'chat-bridge': { kind: 'chat-bridge' } & ContextFormed
  }
}
import type { Context } from '@deepseek-ai/cordis'
// Side-effect type imports: declaration-merge `agents` and `sessions` onto Context.
import type {} from '@deepseek-ai/dsh-agent'
import { BridgeConnection, BridgeToolError } from './mcp.ts'
import { renderChatBridgeFraming } from './framing.ts'
import { parseWireText, truncateBody } from './wire.ts'
import type { ResolvedReconnectPolicy } from './reconnect.ts'
import type { BindingRow } from './storage.ts'
import type { BindingSource, BridgeMessage, WakeMode } from './types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Human-readable reason for logging, without any credential material. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Extract the applied room name from the `apply_agent_name` JSON payload.
 * @param payload - The tool's text content.
 * @returns The room name to join with.
 */
export function parseAppliedName(payload: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch (error: unknown) {
    throw new Error(`apply_agent_name returned a non-JSON payload: ${describeError(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || !('name' in parsed)) {
    throw new Error('apply_agent_name returned no room name')
  }
  const { name } = parsed
  if (typeof name !== 'string' || name.length === 0) throw new Error('apply_agent_name returned an empty room name')
  return name
}

/** Resolved inputs for one binding's loop. */
export interface BindingLoopOptions {
  /** Host services used to resolve, wake, and flush the bound Session. */
  readonly ctx: Context
  /** Session the wake delivers into. */
  readonly sessionId: SessionId
  /** chat-bridge MCP Streamable HTTP endpoint. */
  readonly url: string
  /** Room credential for the connection headers. */
  readonly cookie: string
  /** Declared or stored room name tried before applying for a new one. */
  readonly initialName: string | undefined
  /** Cursor the first poll starts from. */
  readonly initialSince: number
  /** Long-poll duration per get_messages call, in seconds. */
  readonly pollWaitSeconds: number
  /** Per-message UTF-8 byte budget applied before delivery. */
  readonly maxMessageBytes: number
  /** Wake scope: `idle-only` delivers every visible message; `always` delivers only addressed ones. */
  readonly wake: WakeMode
  /** Where the binding came from; durable writes keep the distinction. */
  readonly source: BindingSource
  /** Resolved reconnect policy. */
  readonly policy: ResolvedReconnectPolicy
  /** Durable row write; the cursor commits only after a wake flushed. */
  readonly commit: (row: BindingRow) => Promise<void>
}

/** Poll loop owning one binding's connection, cursor, and wake delivery. */
export class BindingLoop {
  private readonly connection: BridgeConnection
  private readonly halt = new AbortController()
  private stopping = false
  private failures = 0
  private joinedName: string | undefined
  private since: number
  private done: Promise<void> | undefined

  /**
   * @param options - Resolved inputs; the loop owns its connection from here.
   */
  constructor(private readonly options: BindingLoopOptions) {
    this.connection = new BridgeConnection(options.url, options.cookie)
    this.since = options.initialSince
  }

  /** Begin the loop once; the promise settles when the loop stops or gives up. */
  start(): Promise<void> {
    this.done ??= this.run()
    return this.done
  }

  /** Stop polling, abort an in-flight long poll, then release the connection. */
  async stop(): Promise<void> {
    this.stopping = true
    this.halt.abort()
    await this.done
    await this.connection.close()
  }

  private async run(): Promise<void> {
    const { ctx, sessionId, policy } = this.options
    while (!this.stopping) {
      try {
        const reader = await this.ensureConnected()
        const woke = await this.pollBatch(reader)
        if (!woke) return
        this.failures = 0
      } catch (error) {
        if (this.halt.signal.aborted) return
        if (!policy.enabled) {
          ctx.logger.error(`chat-bridge-binder: binding for Session "${sessionId}" failed and reconnect is disabled; reload the plugin or restart the Host to retry: ${describeError(error)}`)
          return
        }
        this.failures += 1
        if (this.failures > policy.maxAttempts) {
          ctx.logger.error(`chat-bridge-binder: binding for Session "${sessionId}" gave up after ${policy.maxAttempts} consecutive failed attempts; reload the plugin or restart the Host to retry`)
          return
        }
        const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (this.failures - 1))
        ctx.logger.warn(`chat-bridge-binder: binding for Session "${sessionId}" failed (attempt ${this.failures}/${policy.maxAttempts}); retrying in ${delayMs}ms: ${describeError(error)}`)
        if (!await this.sleep(delayMs)) return
      }
    }
  }

  /** Connect when needed and land the join handshake; returns the joined name. */
  private async ensureConnected(): Promise<string> {
    if (this.connection.connected && this.joinedName !== undefined) return this.joinedName
    await this.connection.connect()
    const name = await this.join()
    this.joinedName = name
    return name
  }

  /** Join under a known name, falling back to one fresh apply. */
  private async join(): Promise<string> {
    const candidates = [...new Set([this.joinedName, this.options.initialName]
      .filter((name): name is string => name !== undefined))]
    for (const name of candidates) {
      try {
        await this.call('join_room', { name })
        return name
      } catch (error) {
        // A name that was never applied falls back to the apply flow; transport failures propagate.
        if (!(error instanceof BridgeToolError)) throw error
        this.options.ctx.logger.warn(`chat-bridge-binder: joining as "${name}" failed; applying for a new name: ${describeError(error)}`)
      }
    }
    const applied = await this.call('apply_agent_name', { role: 'Server' })
    const name = parseAppliedName(applied)
    await this.call('join_room', { name })
    await this.options.commit(this.row(name, this.since))
    return name
  }

  /**
   * Call one room tool, discarding the connection generation on a
   * transport-level failure. A server-terminated MCP session keeps failing on
   * its dead transport, so the next attempt must connect and join again.
   */
  private async call(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      return await this.connection.call(name, args, this.callTimeoutMs(), this.halt.signal)
    } catch (error) {
      if (!(error instanceof BridgeToolError)) this.connection.invalidate()
      throw error
    }
  }

  /** Timeout for one tool call, covering the configured long-poll wait. */
  private callTimeoutMs(): number {
    return this.options.pollWaitSeconds * 1000 + 10_000
  }

  /** Poll once, deliver addressed messages, and commit the cursor. */
  private async pollBatch(reader: string): Promise<boolean> {
    const text = await this.call('get_messages', {
      since: this.since, reader, for_member: reader, wait_seconds: this.options.pollWaitSeconds,
    })
    const parsed = parseWireText(text)
    for (const id of parsed.unparsedIds) {
      this.options.ctx.logger.warn(`chat-bridge-binder: room message header ${id} for Session "${this.options.sessionId}" could not be parsed; it advances the cursor without delivery`)
    }
    const deliverable = parsed.messages.filter(message =>
      message.id > this.since
      && (this.options.wake === 'idle-only' || message.target === reader))
    if (deliverable.length > 0 && !await this.deliver(reader, deliverable)) return false
    if (parsed.maxSeenId > this.since) await this.commit(reader, parsed.maxSeenId)
    return true
  }

  /** Wake the bound Session with one merged followup; the cursor commits only after flush. */
  private async deliver(reader: string, messages: readonly BridgeMessage[]): Promise<boolean> {
    const { ctx, sessionId, maxMessageBytes } = this.options
    const bounded = messages.map(message => ({ ...message, body: truncateBody(message.body, maxMessageBytes) }))
    const text = renderChatBridgeFraming(reader, bounded)
    await ctx.agents.withoutInitiator(async () => {
      const resolved = await ctx.sessionController.resolveAgent(sessionId)
      if ('error' in resolved) throw resolved.error
      // Disposal can land while Session restoration is awaited.
      if (this.stopping) return
      resolved.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'chat-bridge' } }))
      const flushed = await ctx.sessions.flush(resolved.agent.session)
      if (!flushed) throw new Error('Session persistence did not acknowledge the chat-bridge wake delivery')
    })
    return !this.stopping
  }

  /** Durable cursor write; the in-memory cursor moves only after the row lands. */
  private async commit(reader: string, since: number): Promise<void> {
    await this.options.commit(this.row(reader, since))
    this.since = since
  }

  /** One durable row for this binding's current name, cursor, scope, and source. */
  private row(agentName: string, since: number): BindingRow {
    return {
      sessionId: this.options.sessionId, agentName, cookie: this.options.cookie,
      since, status: 'active', source: this.options.source, wake: this.options.wake,
    }
  }

  /** Backoff wait resolved by the delay or an abort. */
  private sleep(delayMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (woke: boolean): void => {
        clearTimeout(timer)
        this.halt.signal.removeEventListener('abort', onAbort)
        resolve(woke)
      }
      const onAbort = (): void => { finish(false) }
      const timer = setTimeout(() => { finish(true) }, delayMs)
      timer.unref()
      this.halt.signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}

/** Pre-bind room handshake outcome: the joined name and baseline cursor, or why the room refused it. */
export type RoomCheck =
  | { readonly ok: true; readonly name: string; readonly since: number }
  | { readonly ok: false; readonly reason: 'unreachable' | 'rejected' }

/**
 * Verify one room credential before a runtime binding lands. The connection
 * joins under the supplied name when the room already applied it, otherwise
 * applies for a fresh name and joins with it, then reads the room's current
 * message window to baseline the cursor so binding does not wake the Session
 * with messages that predate it.
 * @param url - chat-bridge MCP Streamable HTTP endpoint.
 * @param cookie - room credential for the connection headers.
 * @param name - existing room name to try first; omission applies for one.
 * @param timeoutMs - bound on each handshake tool call.
 * @param accessKey - access key a private room requires for the first join.
 * @returns the joined name and baseline cursor, or the category of refusal without credential material.
 */
export async function checkRoom(
  url: string,
  cookie: string,
  name: string | undefined,
  timeoutMs: number,
  accessKey?: string,
): Promise<RoomCheck> {
  const connection = new BridgeConnection(url, cookie)
  const signal = new AbortController().signal
  const join = async (member: string): Promise<void> => {
    await connection.call(
      'join_room',
      accessKey === undefined ? { name: member } : { name: member, access_key: accessKey },
      timeoutMs,
      signal,
    )
  }
  try {
    await connection.connect()
    let joined = name
    if (joined !== undefined) {
      try {
        await join(joined)
      } catch {
        // A name the room never applied, or a refused join, falls back to applying a fresh one.
        joined = undefined
      }
    }
    if (joined === undefined) {
      const applied = await connection.call('apply_agent_name', { role: 'Server' }, timeoutMs, signal)
      joined = parseAppliedName(applied)
      await join(joined)
    }
    const window = await connection.call(
      'get_messages', { since: 0, wait_seconds: 0, for_member: joined, reader: joined }, timeoutMs, signal,
    )
    return { ok: true, name: joined, since: parseWireText(window).maxSeenId }
  } catch (error) {
    return { ok: false, reason: error instanceof BridgeToolError ? 'rejected' : 'unreachable' }
  } finally {
    await connection.close()
  }
}
