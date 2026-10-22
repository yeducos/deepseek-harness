/** Chat-bridge binder tests use real domain storage, a fake Session resolver, and a fake room server. */

import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { CreateSessionOptions } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ChatBridgeBinderService, { type Config } from '../src/index.ts'

/**
 * Agent fixture whose follow-up entry stays a spy property.
 *
 * `Agent` declares `followup` as a method, so reading it off the interface
 * would hand callers an unbound method reference; the fixture's own type keeps
 * it a property of function type, which is what the runtime stores.
 */
export interface HarnessAgent extends Agent {
  /** Spy recording every message a wake delivered to this Agent. */
  followup: Mock<(message: UserMessage) => void>
}

/** Build an unregistered Agent for a test-owned Session.
 * @param ctx - Services owning the Session.
 * @param id - Unique Session identity within the test Context.
 * @param meta - Optional Session creation metadata, such as subagent lineage.
 * @returns Agent whose follow-up entry is a spy.
 */
export function agentFor(ctx: Context, id = 'original', meta?: CreateSessionOptions['meta']): HarnessAgent {
  const session = ctx.sessions.create(SessionId(id), meta === undefined ? undefined : { meta })
  return {
    id: session.id, session, ctx: ctx.extend(), options: {}, status: 'idle', inbox: unsupportedInbox(),
    send() {}, followup: vi.fn<(message: UserMessage) => void>(), steer() {}, inject() {}, cancel() {},
    whenIdle: async () => {}, runMaintenance: operation => operation(new AbortController().signal),
  }
}

/** Create isolated services with an explicit fake Session resolver.
 * @param options - Optional resolver, pre-service storage state, and binder config.
 * @returns Context, durable storage, service, fixture Agent, resolver spy, and flush spy.
 */
export async function harness(options: {
  beforeService?: (ctx: Context, facility: DomainFacility) => Promise<void>
  onContext?: (ctx: Context) => void
  config?: Config
  /** Session id for a fixture Agent the default resolver returns; omit for a throwing resolver. */
  agent?: string
  resolve?: Context['sessionController']['resolveAgent']
  /** Media pool shared with the caller so it can inject write failures before the service loads. */
  pool?: MemoryMediaPool
  /** Omit the `session/flush` listener so `ctx.sessions.flush()` reports no persistence acknowledgement. */
  silentPersistence?: true
  /** Construct the service directly, bypassing Schemastery so the raw config reaches the constructor. */
  direct?: true
} = {}) {
  const ctx = new Context()
  options.onContext?.(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Storage)
  const pool = options.pool ?? new MemoryMediaPool()
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  const agent = options.agent === undefined ? undefined : agentFor(ctx, options.agent)
  const resolve = vi.fn<Context['sessionController']['resolveAgent']>(
    options.resolve
    ?? (agent === undefined
      ? async () => { throw new Error('missing Session') }
      : async (sessionId) => {
        if (sessionId !== agent.session.id) throw new Error(`Session "${sessionId}" is not the fixture Session`)
        return { agent }
      }))
  ctx.provide('sessionController', { resolveAgent: resolve } as never)
  const flush = vi.fn(async () => {})
  if (options.silentPersistence !== true) ctx.on('session/flush', flush)
  // This fixture supplies flush behavior above; the binder does not invoke persistence methods directly.
  ctx.provide('sessionPersistence', {} as never)
  await options.beforeService?.(ctx, facility)
  if (options.direct === true) {
    const service = new ChatBridgeBinderService(ctx, options.config ?? { url: '' })
    await service[Service.init]()
    return { ctx, service, agent, resolve, flush, fiber: ctx.fiber, pool }
  }
  const fiber = await ctx.plugin(ChatBridgeBinderService, options.config)
  return { ctx, service: ctx.chatBridgeBinder, agent, resolve, flush, fiber, pool }
}
