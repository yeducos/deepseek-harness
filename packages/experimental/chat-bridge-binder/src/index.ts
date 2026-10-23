/**
 * Chat-bridge binder plugin: holds durable bindings between harness Sessions
 * and chat-bridge rooms and runs one background poll loop per active binding;
 * a room message addressed to the bound agent wakes the bound Session.
 *
 * Bindings arrive from cordis.yml declarations or from the runtime API, which
 * a Client uses to bind the open Session without editing or reloading
 * configuration. The room cookie is a durable credential that only travels in
 * connection headers. Delivery reuses the schedule mechanism: resolve,
 * followup, flush, then commit the cursor, so a crash redelivers rather than
 * loses a wake.
 *
 * @module @deepseek-ai/dsh-experimental-chat-bridge-binder
 */

import { readFile } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-workspace'
import { SessionId } from '@deepseek-ai/dsh-session'
import { BindingId, NameMemoryId } from './brand.ts'
import type { BindingId as BindingKey } from './brand.ts'
import { DEFAULT_ENDPOINT_ROWS, rewriteEndpoint } from './endpoint.ts'
import type { EndpointRewrite } from './endpoint.ts'
import { resolveReconnectPolicy } from './reconnect.ts'
import type { ResolvedReconnectPolicy } from './reconnect.ts'
import { chatBridgeBinderDomain } from './storage.ts'
import type { BindingRow } from './storage.ts'
import { BindingLoop, checkRoom } from './runtime.ts'
import { leaveRoom, listRooms, resolveRoom, roomPageUrl } from './rooms.ts'
import { replaceFileAtomically } from './write.ts'
import type {
  BindRequest, BindResult, BindingSource, BindingStatus, BindingView, Config, EndpointInfo, LeaveRequest, LeaveResult,
  ReconnectConfig, RejoinRequest, RejoinResult, ResolveRequest, ResolveResult, RoomListResult,
  SetEndpointRequest, SetEndpointResult, UnbindRequest, UnbindResult, WakeMode,
} from './types.ts'

export type {
  BindFailureCode, BindRequest, BindResult, BindingConfig, BindingSource, BindingStatus, BindingView,
  Config, EndpointInfo, LeaveRequest, LeaveResult, ReconnectConfig, RejoinFailureCode, RejoinRequest, RejoinResult,
  ResolvedRoom, ResolveFailureCode, ResolveRequest, ResolveResult, RoomListResult, RoomSummary,
  SetEndpointFailureCode, SetEndpointRequest, SetEndpointResult, UnbindRequest, UnbindResult, WakeMode,
} from './types.ts'
export { BindingId, NameMemoryId } from './brand.ts'
export { DEFAULT_ENDPOINT_ROWS, EndpointRewriteError, rewriteEndpoint } from './endpoint.ts'
export type { EndpointRewrite } from './endpoint.ts'
export { chatBridgeBinderDomain, bindingRowSchema, nameMemoryRowSchema } from './storage.ts'
export type { BindingRow, NameMemoryRow } from './storage.ts'
export { resolveReconnectPolicy, RECONNECT_DEFAULTS } from './reconnect.ts'
export type { ResolvedReconnectPolicy } from './reconnect.ts'
export { parseWireText, truncateBody } from './wire.ts'
export { renderChatBridgeFraming } from './framing.ts'
export { parseAppliedName, BindingLoop, checkRoom } from './runtime.ts'
export type { RoomCheck } from './runtime.ts'
export { leaveRoom, listRooms, parseRoomList, resolveRoom } from './rooms.ts'
export type { LeaveRoomResult } from './rooms.ts'
export { BridgeConnection, BridgeToolError } from './mcp.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable chat-bridge room bindings that wake bound Sessions. */
    chatBridgeBinder: ChatBridgeBinderService
  }
}

/** Long-poll duration applied when the deployment states none. */
const DEFAULT_POLL_WAIT_SECONDS = 60

/** Per-message UTF-8 byte budget applied when the deployment states none. */
const DEFAULT_MAX_MESSAGE_BYTES = 16_384

/** Bound on room handshakes and room-list requests applied when the deployment states none. */
const DEFAULT_BIND_TIMEOUT_MS = 15_000

const Reconnect: z<ReconnectConfig> = z.object({
  enabled: z.boolean().default(true),
  initialDelayMs: z.number().min(1).default(500),
  maxDelayMs: z.number().min(1).default(30_000),
  maxAttempts: z.number().step(1).min(1).default(10),
})

/** Inputs one loop needs before any durable row exists (a declared name may stay unset until join). */
interface LoopSeed {
  readonly sessionId: SessionId
  readonly agentName: string | undefined
  readonly cookie: string
  readonly since: number
  readonly status: BindingStatus
  readonly source: BindingSource
  readonly wake: WakeMode
}

/** One validated binding, with its Session identity branded for the wake path. */
interface BindingPlan {
  readonly sessionId: SessionId
  readonly cookie: string
  readonly agentName: string | undefined
  readonly since: number | undefined
  readonly wake: WakeMode
}

/**
 * Durable chat-bridge room bindings that wake bound Sessions.
 *
 * `sessionPersistence` is a load-order requirement rather than a directly
 * called service: a wake commits only when `ctx.sessions.flush()` reports
 * that a `session/flush` listener participated, and the persistence backend
 * providing this service is the plugin that registers that listener.
 */
export class ChatBridgeBinderService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'storageDomain', 'sessionController', 'sessionPersistence']

  static Config: z<Config> = z.object({
    url: z.string().required(),
    pollWaitSeconds: z.number().step(1).min(1).max(300).default(DEFAULT_POLL_WAIT_SECONDS),
    maxMessageBytes: z.number().step(1).min(256).max(1_048_576).default(DEFAULT_MAX_MESSAGE_BYTES),
    bindTimeoutMs: z.number().step(1).min(1_000).max(120_000).default(DEFAULT_BIND_TIMEOUT_MS),
    reconnect: Reconnect,
    bindings: z.array(z.object({
      sessionId: z.string().required(),
      cookie: z.string().required(),
      agentName: z.string(),
      since: z.number().step(1).min(0),
      wake: z.union(['idle-only', 'always'] as const).default('idle-only'),
    })),
    endpointRows: z.array(z.string()).default([...DEFAULT_ENDPOINT_ROWS]),
  })

  private readonly url: string
  private readonly endpointRows: readonly string[]
  private readonly pollWaitSeconds: number
  private readonly maxMessageBytes: number
  private readonly bindTimeoutMs: number
  private readonly policy: ResolvedReconnectPolicy
  private readonly plans: readonly BindingPlan[]
  private readonly ready: Promise<Domain<typeof chatBridgeBinderDomain>>
  private readonly initialized: PromiseLike<unknown>
  private readonly loops = new Map<BindingKey, BindingLoop>()
  private readonly wakeModes = new Map<BindingKey, WakeMode>()

  /**
   * @param ctx - Host services owning storage, dispatch, and Session restoration.
   * @param config - Validated binder configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'chatBridgeBinder')
    let parsed: URL
    try {
      parsed = new URL(config.url)
    } catch {
      throw new Error('chat-bridge-binder: url must be a valid URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('chat-bridge-binder: url must use http or https')
    }
    this.url = config.url
    this.endpointRows = config.endpointRows ?? DEFAULT_ENDPOINT_ROWS
    if (this.endpointRows.length === 0 || this.endpointRows.some(id => id.trim() === '')) {
      throw new Error('chat-bridge-binder: endpointRows entries must not be empty')
    }
    this.pollWaitSeconds = config.pollWaitSeconds ?? DEFAULT_POLL_WAIT_SECONDS
    this.maxMessageBytes = config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
    this.bindTimeoutMs = config.bindTimeoutMs ?? DEFAULT_BIND_TIMEOUT_MS
    this.policy = resolveReconnectPolicy(config.reconnect, 'chat-bridge-binder.reconnect')
    this.plans = (config.bindings ?? []).map((plan) => {
      if (plan.sessionId.length === 0) throw new Error('chat-bridge-binder: bindings[].sessionId must not be empty')
      if (plan.cookie.length === 0) throw new Error('chat-bridge-binder: bindings[].cookie must not be empty')
      if (/[\r\n]/.test(plan.cookie)) throw new Error('chat-bridge-binder: bindings[].cookie must not contain line breaks')
      if (plan.agentName !== undefined && plan.agentName.length === 0) {
        throw new Error('chat-bridge-binder: bindings[].agentName must not be empty')
      }
      return {
        sessionId: SessionId(plan.sessionId), cookie: plan.cookie, agentName: plan.agentName,
        since: plan.since, wake: plan.wake ?? 'idle-only',
      }
    })
    const seen = new Set<string>()
    for (const plan of this.plans) {
      if (seen.has(plan.sessionId)) throw new Error(`chat-bridge-binder: Session "${plan.sessionId}" is bound more than once`)
      seen.add(plan.sessionId)
      this.wakeModes.set(BindingId(plan.sessionId), plan.wake)
    }
    this.ready = ctx.storageDomain.open(chatBridgeBinderDomain)
    this.initialized = ctx.effect(async () => {
      const domain = await this.ready
      const stopLoops = async (): Promise<void> => {
        await Promise.allSettled([...this.loops.values()].map(loop => loop.stop()))
      }
      try {
        await this.applyDeclarations(domain)
        this.startDeclaredLoops(domain)
        this.startRestoredLoops(domain)
        const stop = this.ctx.on('workspace/session-stop', ({ sessionId }) => this.handleSessionStop(sessionId))
        return async () => {
          stop()
          await stopLoops()
          await domain.close()
        }
      } catch (error) {
        await stopLoops()
        await domain.close()
        throw error
      }
    })
  }

  async [Service.init](): Promise<void> {
    await this.initialized
  }

  /**
   * List every binding this Host holds, declared or runtime.
   * @returns bindings without room credentials, ordered by Session id.
   */
  @Remote
  async list(): Promise<readonly BindingView[]> {
    const bindings = (await this.ready).table('bindings')
    return [...bindings.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, row]) => viewOf(row, this.url))
  }

  /**
   * Read the public room list for the binding form. The listing carries no
   * credential, so it locates rooms without joining any of them.
   * @returns the public rooms, or that the room service was unreachable.
   */
  @Remote
  async rooms(): Promise<RoomListResult> {
    return await listRooms(this.url, this.bindTimeoutMs)
  }

  /**
   * Read the chat-bridge service address this Host loaded from its configuration.
   * @returns the effective MCP endpoint of the running plugin.
   */
  @Remote
  endpoint(): Promise<EndpointInfo> {
    return Promise.resolve({ url: this.url })
  }

  /**
   * Persist a new service address into every configured profile patch row. The
   * running plugin keeps its loaded address, so the change takes effect on the
   * next start; no loader reload or storage write happens here.
   * @param request - the replacement endpoint, which must use http or https.
   * @returns the persisted address with `restartRequired`, or the failure category.
   */
  @Remote
  async setEndpoint(request: SetEndpointRequest): Promise<SetEndpointResult> {
    const url = request.url.trim()
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, code: 'invalid-url' }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, code: 'invalid-url' }
    // Only a profile launch owns an editable patch file; other launches refuse the edit.
    const profile = this.ctx.get('profileContext')
    if (profile === undefined) return { ok: false, code: 'profile-unavailable' }
    let source: string
    try {
      source = await readFile(profile.patchPath, 'utf8')
    } catch {
      return { ok: false, code: 'profile-unavailable' }
    }
    let rewritten: EndpointRewrite
    try {
      rewritten = rewriteEndpoint(source, url, this.endpointRows)
    } catch {
      return { ok: false, code: 'row-missing' }
    }
    if (rewritten.changed) {
      try {
        await replaceFileAtomically(profile.patchPath, rewritten.source)
      } catch {
        return { ok: false, code: 'write-failed' }
      }
    }
    return { ok: true, url, restartRequired: true }
  }

  /**
   * Turn an invite link, a room id, or a room cookie into the cookie a bind
   * needs. Selecting a listed room and pasting an invite link both take this
   * path; a private room answers only under a valid access key.
   * @param request - The room reference as entered, plus an optional access key.
   * @returns the resolved room with its cookie, or the refusal category.
   */
  @Remote
  async resolve(request: ResolveRequest): Promise<ResolveResult> {
    const value = request.value.trim()
    if (value.length === 0 || /[\r\n]/.test(value)) return { ok: false, code: 'invalid-value' }
    const accessKey = request.accessKey?.trim()
    if (accessKey !== undefined && /[\r\n]/.test(accessKey)) return { ok: false, code: 'invalid-value' }
    return await resolveRoom(this.url, value, accessKey === '' ? undefined : accessKey, this.bindTimeoutMs)
  }

  /**
   * Bind one live Session to a room and start watching it. The room handshake
   * runs before anything durable changes, so a wrong credential leaves the
   * existing binding untouched. Without an explicit name, the name this
   * Session last joined in this room is retried first, so re-binding keeps the
   * same member identity.
   * @param request - Session, room credential, optional name and wake scope.
   * @returns the new binding, or the refusal category.
   */
  @Remote
  async bind(request: BindRequest): Promise<BindResult> {
    const sessionId = request.sessionId.trim()
    if (sessionId.length === 0) return { ok: false, code: 'session-unknown' }
    if (request.cookie.trim().length === 0 || /[\r\n]/.test(request.cookie)) return { ok: false, code: 'invalid-cookie' }
    const name = request.agentName?.trim()
    if (name !== undefined && name.length === 0) return { ok: false, code: 'invalid-name' }
    const bound = SessionId(sessionId)
    if (this.ctx.sessions.get(bound) === undefined) return { ok: false, code: 'session-unknown' }
    const key = BindingId(bound)
    const bindings = (await this.ready).table('bindings')
    const stored = bindings.get(key)
    if (this.declaredSessions().has(bound) || stored?.source === 'declared') return { ok: false, code: 'declared-binding' }
    const wake = request.wake ?? 'idle-only'
    const accessKey = request.accessKey?.trim()
    if (accessKey !== undefined && /[\r\n]/.test(accessKey)) return { ok: false, code: 'invalid-cookie' }
    // A name this Session already used in this room re-enters as the same member;
    // the handshake falls back to a fresh name when the room rejects it.
    const names = (await this.ready).table('names')
    const nameKey = NameMemoryId(bound, request.cookie)
    const checked = await checkRoom(
      this.url, request.cookie, name ?? names.get(nameKey)?.agentName,
      this.bindTimeoutMs, accessKey === '' ? undefined : accessKey,
    )
    if (!checked.ok) return { ok: false, code: checked.reason === 'rejected' ? 'room-rejected' : 'room-unreachable' }
    // A member that left the room starts from the current backlog instead of replaying missed messages.
    const since = stored?.status === 'left' ? checked.since : stored?.since ?? checked.since
    const row: BindingRow = {
      sessionId: bound, agentName: checked.name, cookie: request.cookie,
      since, status: 'active', source: 'runtime', wake,
    }
    await this.stopLoop(key)
    await bindings.put(key, row)
    // The memory outlives an unbind: the next bind in this room keeps the member name.
    await names.put(nameKey, { agentName: checked.name })
    this.startLoop(row)
    return { ok: true, binding: viewOf(row, this.url) }
  }

  /**
   * Remove one runtime binding and stop watching its room.
   * @param request - Session whose runtime binding is removed.
   * @returns whether a row was removed, or that declarations own the binding.
   */
  @Remote
  async unbind(request: UnbindRequest): Promise<UnbindResult> {
    const sessionId = request.sessionId.trim()
    if (sessionId.length === 0) return { ok: true, removed: false }
    const bound = SessionId(sessionId)
    const key = BindingId(bound)
    const bindings = (await this.ready).table('bindings')
    const stored = bindings.get(key)
    if (this.declaredSessions().has(bound) || stored?.source === 'declared') return { ok: false, code: 'declared-binding' }
    await this.stopLoop(key)
    if (stored === undefined) return { ok: true, removed: false }
    await bindings.delete(key)
    return { ok: true, removed: true }
  }

  /**
   * Remove the bound member from its room and keep the binding. The Session
   * stops receiving room messages until it rejoins; polling stops first so the
   * loop cannot race the leave with a fresh apply for a name.
   * @param request - Session whose bound member leaves its room.
   * @returns whether the member left, was already gone, or the room was unreachable.
   */
  @Remote
  async leave(request: LeaveRequest): Promise<LeaveResult> {
    const sessionId = request.sessionId.trim()
    if (sessionId.length === 0) return { ok: false, code: 'session-unknown' }
    const key = BindingId(SessionId(sessionId))
    const bindings = (await this.ready).table('bindings')
    const row = bindings.get(key)
    if (row === undefined) return { ok: false, code: 'not-bound' }
    if (row.status === 'left') return { ok: true }
    await this.stopLoop(key)
    const result = await leaveRoom(this.url, row.cookie, row.agentName, this.bindTimeoutMs)
    if (!result.ok) {
      // The member almost certainly still sits in the room; keep watching it so view and room agree.
      this.startLoop(row)
      return { ok: false, code: 'room-unreachable' }
    }
    await bindings.put(key, { ...row, status: 'left' })
    return { ok: true }
  }

  /**
   * Re-enter the room of a binding whose member left. The join handshake runs
   * first, then the cursor resets to the room's current backlog so re-entering
   * does not replay messages missed while away.
   * @param request - Session whose binding re-enters, plus a fresh private-room key.
   * @returns the active binding, or the refusal category.
   */
  @Remote
  async rejoin(request: RejoinRequest): Promise<RejoinResult> {
    const sessionId = request.sessionId.trim()
    if (sessionId.length === 0) return { ok: false, code: 'session-unknown' }
    const bound = SessionId(sessionId)
    const key = BindingId(bound)
    const bindings = (await this.ready).table('bindings')
    const row = bindings.get(key)
    if (row === undefined) return { ok: false, code: 'not-bound' }
    if (row.status !== 'left') return { ok: false, code: 'not-left' }
    const accessKey = request.accessKey?.trim()
    const checked = await checkRoom(
      this.url, row.cookie, row.agentName, this.bindTimeoutMs, accessKey === '' ? undefined : accessKey,
    )
    if (!checked.ok) return { ok: false, code: checked.reason === 'rejected' ? 'room-rejected' : 'room-unreachable' }
    const next: BindingRow = { ...row, agentName: checked.name, since: checked.since, status: 'active' }
    await this.stopLoop(key)
    await bindings.put(key, next)
    this.startLoop(next)
    return { ok: true, binding: viewOf(next, this.url) }
  }

  /** Upsert one row per declared binding and drop declared rows whose declaration was removed. */
  private async applyDeclarations(domain: Domain<typeof chatBridgeBinderDomain>): Promise<void> {
    const bindings = domain.table('bindings')
    const declaredKeys = new Set<BindingKey>()
    for (const plan of this.plans) {
      const key = BindingId(plan.sessionId)
      declaredKeys.add(key)
      const stored = bindings.get(key)
      const agentName = plan.agentName ?? stored?.agentName
      if (agentName === undefined) continue
      // An explicit leave survives a reload; declarations do not drag the member back in.
      await bindings.put(key, {
        sessionId: plan.sessionId, agentName, cookie: plan.cookie,
        since: stored?.since ?? plan.since ?? 0,
        status: stored?.status === 'left' ? 'left' : 'active', source: 'declared', wake: plan.wake,
      })
    }
    for (const [key, row] of bindings.entries()) {
      // Runtime bindings survive removed declarations; only their own Session unbinds them.
      if (row.source === 'declared' && !declaredKeys.has(key)) await bindings.delete(key)
    }
  }

  /** Start one loop per declared binding, seeded from its stored row when present. */
  private startDeclaredLoops(domain: Domain<typeof chatBridgeBinderDomain>): void {
    const bindings = domain.table('bindings')
    for (const plan of this.plans) {
      const key = BindingId(plan.sessionId)
      const stored = bindings.get(key)
      if (stored?.status === 'left') continue
      this.startLoop({
        sessionId: plan.sessionId, agentName: plan.agentName ?? stored?.agentName, cookie: plan.cookie,
        since: stored?.since ?? plan.since ?? 0, status: 'active', source: 'declared', wake: plan.wake,
      })
    }
  }

  /** Restart loops for runtime bindings that survived a reload. */
  private startRestoredLoops(domain: Domain<typeof chatBridgeBinderDomain>): void {
    for (const [, row] of domain.table('bindings').entries()) {
      if (row.source !== 'runtime' || row.status === 'left') continue
      this.startLoop(row)
    }
  }

  /** Register and start one loop for a durable or declared binding. */
  private startLoop(seed: LoopSeed): void {
    const key = BindingId(seed.sessionId)
    this.wakeModes.set(key, seed.wake)
    const bindingsPromise = this.ready
    const loop = new BindingLoop({
      ctx: this.ctx,
      sessionId: seed.sessionId,
      url: this.url,
      cookie: seed.cookie,
      initialName: seed.agentName,
      initialSince: seed.since,
      pollWaitSeconds: this.pollWaitSeconds,
      maxMessageBytes: this.maxMessageBytes,
      wake: seed.wake,
      source: seed.source,
      policy: this.policy,
      commit: async (next: BindingRow) => { await (await bindingsPromise).table('bindings').put(key, next) },
    })
    this.loops.set(key, loop)
    void loop.start()
  }

  /** End and forget one loop without touching its durable row. */
  private async stopLoop(key: BindingKey): Promise<void> {
    const loop = this.loops.get(key)
    if (loop === undefined) return
    this.loops.delete(key)
    await loop.stop()
  }

  /** Sessions whose binding is owned by cordis.yml for this load. */
  private declaredSessions(): Set<SessionId> {
    return new Set(this.plans.map(plan => plan.sessionId))
  }

  /** Mark the binding of one stopped Session stopped and end its loop. */
  private async handleSessionStop(sessionId: SessionId): Promise<void> {
    const key = BindingId(sessionId)
    const loop = this.loops.get(key)
    if (loop === undefined) return
    // `always` bindings keep polling so a room message can restart a stopped Session.
    if (this.wakeModes.get(key) === 'always') return
    this.loops.delete(key)
    await loop.stop()
    try {
      const bindings = (await this.ready).table('bindings')
      const row = bindings.get(key)
      if (row !== undefined) await bindings.put(key, { ...row, status: 'stopped' })
    } catch (error: unknown) {
      this.ctx.logger.warn(`chat-bridge-binder: marking the stopped binding for Session "${sessionId}" failed: ${String(error)}`)
    }
  }
}

/** Project one durable row onto the credential-free runtime view. */
function viewOf(row: BindingRow, url: string): BindingView {
  return {
    sessionId: row.sessionId, agentName: row.agentName, since: row.since,
    status: row.status, wake: row.wake, source: row.source,
    roomUrl: roomPageUrl(url, row.cookie),
  }
}

export default ChatBridgeBinderService
