/** The binding form and its generated Remote leave together, and a failed mount rolls the Remote back. */
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { InjectParams, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RemoteError, type RemoteResult, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {
  BindResult, BindingView, EndpointInfo, LeaveResult, RejoinResult, ResolveResult, RoomListResult, SetEndpointResult,
  UnbindResult,
} from '../src/types.ts'
import type { BindingActionInjected } from '../src/client/BindingAction.tsx'
import { inject, mountBinding } from '../src/client/mount.ts'

const contribution: TypertRemoteContribution = { package: '@deepseek-ai/dsh-experimental-chat-bridge-binder', descriptors: [] }
const SESSION = SessionId('bound-session')
const view: BindingView = {
  sessionId: SESSION, agentName: 'AI-Worker-01', since: 0,
  status: 'active', wake: 'idle-only', source: 'runtime',
  roomUrl: 'http://127.0.0.1:8200/room/6ca13d52ca70c883',
}

async function fixture(): Promise<{
  ctx: Context
  ui: Context
  list: ReturnType<typeof vi.fn>
  rooms: ReturnType<typeof vi.fn>
  resolve: ReturnType<typeof vi.fn>
  bind: ReturnType<typeof vi.fn>
  leave: ReturnType<typeof vi.fn>
  rejoin: ReturnType<typeof vi.fn>
  unbind: ReturnType<typeof vi.fn>
  endpoint: ReturnType<typeof vi.fn>
  setEndpoint: ReturnType<typeof vi.fn>
  unmount: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context(), unmount = vi.fn(async () => {})
  class TestRemote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(value: TypertRemoteContribution): Promise<() => Promise<void>> {
      expect(value).toBe(contribution)
      return unmount
    }
  }
  new TestRemote()
  const list = vi.fn<() => Promise<RemoteResult<readonly BindingView[]>>>(async () => ({ ok: true, value: [view] }))
  const rooms = vi.fn<() => Promise<RemoteResult<RoomListResult>>>(async () => ({
    ok: true,
    value: { ok: true, rooms: [{ roomId: 'room-1', name: 'Room One', members: 2, messages: 5 }] },
  }))
  const bind = vi.fn<() => Promise<RemoteResult<BindResult>>>(async () => ({ ok: true, value: { ok: true, binding: view } }))
  const resolve = vi.fn<() => Promise<RemoteResult<ResolveResult>>>(async () => ({
    ok: true,
    value: { ok: true, room: { roomId: 'room-1', name: 'Room One', roomType: 'public', cookie: 'c' } },
  }))
  const leave = vi.fn<() => Promise<RemoteResult<LeaveResult>>>(async () => ({ ok: true, value: { ok: true } }))
  const rejoin = vi.fn<() => Promise<RemoteResult<RejoinResult>>>(async () => ({ ok: true, value: { ok: true, binding: view } }))
  const unbind = vi.fn<() => Promise<RemoteResult<UnbindResult>>>(async () => ({ ok: true, value: { ok: true, removed: true } }))
  const endpoint = vi.fn<() => Promise<RemoteResult<EndpointInfo>>>(async () => ({
    ok: true, value: { url: 'http://127.0.0.1:8200/mcp' },
  }))
  const setEndpoint = vi.fn<() => Promise<RemoteResult<SetEndpointResult>>>(async () => ({
    ok: true, value: { ok: true, url: 'https://bridge.example.com/mcp', restartRequired: true },
  }))
  // The gateway owns a Remote namespace in its own fiber, so the plugin root
  // cannot read `remote.chatBridgeBinder` without injecting that exact key.
  class TestNamespace extends Service {
    constructor(owner: Context) {
      super(owner, 'remote.chatBridgeBinder')
    }
    readonly list = list
    readonly rooms = rooms
    readonly resolve = resolve
    readonly bind = bind
    readonly leave = leave
    readonly rejoin = rejoin
    readonly unbind = unbind
    readonly endpoint = endpoint
    readonly setEndpoint = setEndpoint
  }
  await ctx.plugin({ name: 'remote.chatBridgeBinder', apply: (child) => { new TestNamespace(child) } })
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'conversation.session.header.actions': { kind: 'list', scope: 'session' },
  } } as never, () => null)
  // The browser entry runs under a plugin fiber, where service reads require a
  // declared inject; a root-level read would silently bypass that guard.
  let ui: Context | undefined
  await ctx.plugin({ inject, apply: (child) => { ui = child } })
  expect(() => { Reflect.get(ui!.remote, 'chatBridgeBinder') }).toThrow(/without inject/)
  return {
    ctx, ui: ui!, list, rooms, resolve, bind, leave, rejoin, unbind, endpoint, setEndpoint, unmount,
  }
}

function face(value: Record<string, unknown>): asserts value is Record<string, unknown> & BindingActionInjected {
  assert(typeof value.list === 'function')
  assert(typeof value.rooms === 'function')
  assert(typeof value.resolve === 'function')
  assert(typeof value.bind === 'function')
  assert(typeof value.leave === 'function')
  assert(typeof value.rejoin === 'function')
  assert(typeof value.unbind === 'function')
  assert(typeof value.endpoint === 'function')
  assert(typeof value.setEndpoint === 'function')
}

/** Invoke the header action's injection with its declared Session scope. */
function injectAction(entry: StoredEntry, sessionId: SessionId): Record<string, unknown> {
  assert(typeof entry.inject === 'function')
  const injectFace = entry.inject as (...args: InjectParams<'conversation.session.header.actions', undefined>) => Record<string, unknown>
  return injectFace(sessionId)
}

it('registers the header action and forwards every operation through the Remote', async () => {
  const b = await fixture()
  try {
    const dispose = await mountBinding(b.ui, contribution)
    const entry = b.ctx.slots.entries('conversation.session.header.actions')[0]!
    expect(entry).toMatchObject({ locale: 'chatBridgeBinder', options: { id: 'chat-bridge-binding', order: 30 } })
    expect(b.ctx.slots.spec('conversation.session.header.actions')).toMatchObject({ kind: 'list', scope: 'session' })
    const bound = injectAction(entry, SESSION)
    face(bound)
    expect(await bound.list()).toEqual([view])
    expect(await bound.rooms()).toEqual({
      ok: true, rooms: [{ roomId: 'room-1', name: 'Room One', members: 2, messages: 5 }],
    })
    expect(await bound.bind({ sessionId: SESSION, cookie: 'c', wake: 'always' })).toEqual({ ok: true, binding: view })
    expect(await bound.resolve({ value: 'room-1' })).toMatchObject({ ok: true, room: { cookie: 'c' } })
    expect(await bound.leave({ sessionId: SESSION })).toEqual({ ok: true })
    expect(await bound.rejoin({ sessionId: SESSION })).toEqual({ ok: true, binding: view })
    expect(await bound.unbind(SESSION)).toEqual({ ok: true, removed: true })
    expect(await bound.endpoint()).toEqual({ url: 'http://127.0.0.1:8200/mcp' })
    expect(await bound.setEndpoint({ url: 'https://bridge.example.com/mcp' })).toEqual({
      ok: true, url: 'https://bridge.example.com/mcp', restartRequired: true,
    })
    expect(b.setEndpoint).toHaveBeenCalledWith({ url: 'https://bridge.example.com/mcp' })
    expect(b.bind).toHaveBeenCalledWith({ sessionId: SESSION, cookie: 'c', wake: 'always' })
    expect(b.resolve).toHaveBeenCalledWith({ value: 'room-1' })
    expect(b.leave).toHaveBeenCalledWith({ sessionId: SESSION })
    expect(b.rejoin).toHaveBeenCalledWith({ sessionId: SESSION })
    expect(b.unbind).toHaveBeenCalledWith({ sessionId: SESSION })
    b.bind.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'bind blocked', {}) })
    b.resolve.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'resolve blocked', {}) })
    b.leave.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'leave blocked', {}) })
    b.rejoin.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'rejoin blocked', {}) })
    b.unbind.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'unbind blocked', {}) })
    b.endpoint.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'endpoint blocked', {}) })
    b.setEndpoint.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'setEndpoint blocked', {}) })
    b.rooms.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'rooms blocked', {}) })
    await expect(bound.bind({ sessionId: SESSION, cookie: 'c', wake: 'always' })).rejects.toThrow('bind blocked')
    await expect(bound.resolve({ value: 'room-1' })).rejects.toThrow('resolve blocked')
    await expect(bound.leave({ sessionId: SESSION })).rejects.toThrow('leave blocked')
    await expect(bound.rejoin({ sessionId: SESSION })).rejects.toThrow('rejoin blocked')
    await expect(bound.rooms()).rejects.toThrow('rooms blocked')
    await expect(bound.unbind(SESSION)).rejects.toThrow('unbind blocked')
    await expect(bound.endpoint()).rejects.toThrow('endpoint blocked')
    await expect(bound.setEndpoint({ url: 'https://bridge.example.com/mcp' })).rejects.toThrow('setEndpoint blocked')
    await dispose()
    expect(b.ctx.slots.entries('conversation.session.header.actions')).toHaveLength(0)
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally { await b.ctx.fiber.dispose() }
})

it('surfaces a refused Remote read as an error the form can report', async () => {
  const b = await fixture()
  b.list.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  try {
    const dispose = await mountBinding(b.ui, contribution)
    const bound = injectAction(b.ctx.slots.entries('conversation.session.header.actions')[0]!, SESSION)
    face(bound)
    await expect(bound.list()).rejects.toThrow('offline')
    await dispose()
  } finally { await b.ctx.fiber.dispose() }
})

it('rolls the Remote back when registering the header action fails', async () => {
  const b = await fixture()
  vi.spyOn(b.ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('registration failed') })
  try {
    await expect(mountBinding(b.ui, contribution)).rejects.toThrow('registration failed')
    expect(b.unmount).toHaveBeenCalledOnce()
    expect(b.ctx.slots.entries('conversation.session.header.actions')).toHaveLength(0)
  } finally { await b.ctx.fiber.dispose() }
})

it('loads the browser entry through its generated Remote contribution', async () => {
  const b = await fixture()
  vi.doMock('@deepseek-ai/dsh-experimental-chat-bridge-binder/remote', () => ({ default: contribution }))
  try {
    const browser = await import('../src/client/index.ts')
    expect(browser.inject).toEqual(inject)
    const fiber = b.ctx.plugin({ inject: [...browser.inject], apply: browser.apply })
    await fiber
    expect(b.ctx.slots.entries('conversation.session.header.actions')).toHaveLength(1)
    await fiber.dispose()
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    await b.ctx.fiber.dispose()
    vi.doUnmock('@deepseek-ai/dsh-experimental-chat-bridge-binder/remote')
  }
})
