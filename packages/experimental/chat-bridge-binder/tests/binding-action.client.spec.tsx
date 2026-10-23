// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { BindingAction, type BindingActionProps } from '../src/client/BindingAction.tsx'
import { zh } from '../src/client/locales.ts'
import type { BindingView, BindResult, RoomListResult, RoomSummary, UnbindResult } from '../src/types.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SESSION = 'session' as SessionId
const t: BindingActionProps['t'] = makeTranslate(zh)

/** One runtime binding for this Session. */
function binding(over: Partial<BindingView> = {}): BindingView {
  return {
    sessionId: SESSION, agentName: 'AI-Worker-01', since: 0,
    status: 'active', wake: 'idle-only', source: 'runtime',
    roomUrl: 'http://127.0.0.1:8200/room/6ca13d52ca70c883',
    ...over,
  }
}

/** Resolver that turns any reference into the cookie a bind needs. */
const room = (cookie = 'secret') => vi.fn<BindingActionProps['resolve']>(async () => ({
  ok: true as const,
  room: { roomId: 'room-1', name: 'Room One', roomType: 'public' as const, cookie },
}))

function props(
  list: BindingActionProps['list'] = async () => [],
  bind: BindingActionProps['bind'] = async () => ({ ok: false, code: 'room-rejected' }),
  unbind: BindingActionProps['unbind'] = async () => ({ ok: true, removed: false }),
  rooms: BindingActionProps['rooms'] = async () => ({ ok: true, rooms: [] }),
  over: Partial<BindingActionProps> = {},
): BindingActionProps {
  return {
    sessionId: SESSION,
    list, rooms, bind, unbind, t,
    resolve: async () => ({ ok: false, code: 'room-unknown' }),
    leave: async () => ({ ok: true }),
    rejoin: async () => ({ ok: false, code: 'not-bound' }),
    endpoint: async () => ({ url: 'http://127.0.0.1:8200/mcp' }),
    setEndpoint: async request => ({ ok: true, url: request.url, restartRequired: true }),
    ...over,
  } as BindingActionProps
}

const trigger = (): HTMLElement => screen.getByRole('button', { name: zh['trigger'] })

/** Settle the mount-time binding read before interacting with the panel. */
async function settle(): Promise<void> { await act(async () => { await Promise.resolve() }) }

/** Open the panel's secondary entry form, where invite links and cookies go. */
async function openEntry(): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['entry.toggle'] })) })
}

/** Open the advanced section holding the room name and wake scope. */
async function openAdvanced(): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['advanced'] })) })
}

describe('BindingAction binding', () => {
  it('opens the panel with the unbound identity and the room list', async () => {
    const load = vi.fn(async () => ({ ok: true as const, rooms: [] }))
    render(<BindingAction {...props(async () => [], undefined, undefined, load)} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    expect(screen.getByText(zh['title'])).toBeDefined()
    expect(screen.getByText(zh['status.unbound'])).toBeDefined()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('binds the session with the resolved room, name, and scope', async () => {
    const resolve = room()
    const bind = vi.fn<() => Promise<BindResult>>(async () => ({ ok: true, binding: binding() }))
    render(<BindingAction {...props(async () => [], bind, undefined, undefined, { resolve })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await openEntry()
    await openAdvanced()
    fireEvent.change(screen.getByPlaceholderText(zh['invitePlaceholder']), { target: { value: ' room-1 ' } })
    fireEvent.change(screen.getByPlaceholderText(zh['namePlaceholder']), { target: { value: 'AI-Worker-01' } })
    // Both wake options round-trip through the select; the last value reaches the bind.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'idle-only' } })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'always' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['bind'] })) })
    expect(resolve).toHaveBeenCalledWith({ value: 'room-1' })
    expect(bind).toHaveBeenCalledWith({
      sessionId: SESSION, cookie: 'secret', agentName: 'AI-Worker-01', wake: 'always',
    })
    expect(screen.getByText(zh['boundAs'].replace('{name}', 'AI-Worker-01'))).toBeDefined()
  })

  it('reports a refusal code with its localized copy', async () => {
    const bind = vi.fn<() => Promise<BindResult>>(async () => ({ ok: false, code: 'room-rejected' }))
    render(<BindingAction {...props(async () => [], bind, undefined, undefined, { resolve: room() })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await openEntry()
    fireEvent.change(screen.getByPlaceholderText(zh['invitePlaceholder']), { target: { value: 'bad' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['bind'] })) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.room-rejected'])
  })

  it('reveals the access key only when the resolver reports a private room', async () => {
    const resolve = vi.fn<BindingActionProps['resolve']>(async () => ({ ok: false, code: 'room-private' }))
    render(<BindingAction {...props(async () => [], undefined, undefined, undefined, { resolve })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    expect(screen.queryByPlaceholderText(zh['accessKeyPlaceholder'])).toBeNull()
    await openEntry()
    fireEvent.change(screen.getByPlaceholderText(zh['invitePlaceholder']), { target: { value: 'private' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['bind'] })) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.room-private'])
    expect(screen.getByPlaceholderText(zh['accessKeyPlaceholder'])).toBeDefined()
  })

  it('keeps the form when the remote call itself fails', async () => {
    const bind = vi.fn(async () => { throw new Error('offline') })
    render(<BindingAction {...props(async () => [], bind, undefined, undefined, { resolve: room() })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await openEntry()
    fireEvent.change(screen.getByPlaceholderText(zh['invitePlaceholder']), { target: { value: 'c' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['bind'] })) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.generic'])
  })

  it('refuses an empty entry without calling the resolver', async () => {
    const resolve = room()
    render(<BindingAction {...props(async () => [], undefined, undefined, undefined, { resolve })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await openEntry()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['bind'] })) })
    expect(resolve).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(zh['error.invalid-value'])
  })

  it('asks for the access key when a listed room turns out private', async () => {
    const rooms: readonly RoomSummary[] = [
      { roomId: 'deadbeefdeadbeef', name: 'private room', members: 2, messages: 9 },
    ]
    const resolve = vi.fn<BindingActionProps['resolve']>()
      .mockResolvedValueOnce({ ok: false, code: 'room-private' })
      .mockResolvedValueOnce({
        ok: true,
        room: { roomId: 'deadbeefdeadbeef', name: 'private room', roomType: 'private', cookie: 'private-cookie' },
      })
    const bind = vi.fn<BindingActionProps['bind']>(async () => ({ ok: true, binding: binding() }))
    render(<BindingAction {...props(async () => [], bind, undefined, async () => ({ ok: true, rooms }), { resolve })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await settle()
    await act(async () => { fireEvent.click(screen.getByTitle('deadbeefdeadbeef')) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.room-private'])
    // A private listed room opens the entry form with its key field instead of a dead end.
    expect(screen.getByPlaceholderText(zh['invitePlaceholder'])).toBeDefined()
    fireEvent.change(screen.getByPlaceholderText(zh['accessKeyPlaceholder']), { target: { value: ' vk-typed ' } })
    fireEvent.change(screen.getByPlaceholderText(zh['invitePlaceholder']), { target: { value: 'deadbeefdeadbeef' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['bind'] })) })
    expect(resolve).toHaveBeenLastCalledWith({ value: 'deadbeefdeadbeef', accessKey: 'vk-typed' })
    // The typed key carries the retry; the resolved room has no key of its own.
    expect(bind).toHaveBeenCalledWith({
      sessionId: SESSION, cookie: 'private-cookie', accessKey: 'vk-typed', wake: 'idle-only',
    })
  })

  it('reports an unreachable room service while entering a listed room', async () => {
    const rooms: readonly RoomSummary[] = [
      { roomId: 'faddba2498de6001', name: '打龙战斗协作', members: 0, messages: 18 },
    ]
    const resolve = vi.fn<BindingActionProps['resolve']>(async () => { throw new Error('offline') })
    const bind = vi.fn<BindingActionProps['bind']>(async () => ({ ok: true, binding: binding() }))
    render(<BindingAction {...props(async () => [], bind, undefined, async () => ({ ok: true, rooms }), { resolve })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await settle()
    await act(async () => { fireEvent.click(screen.getByTitle('faddba2498de6001')) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.generic'])
    expect(bind).not.toHaveBeenCalled()
  })

  it('does not ask for a key when the room fails for another reason', async () => {
    const bind = vi.fn<BindingActionProps['bind']>(async () => ({ ok: false, code: 'room-unreachable' }))
    render(<BindingAction {...props(async () => [], bind, undefined, undefined, { resolve: room() })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await openEntry()
    fireEvent.change(screen.getByPlaceholderText(zh['invitePlaceholder']), { target: { value: 'room-1' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['bind'] })) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.room-unreachable'])
    expect(screen.queryByPlaceholderText(zh['accessKeyPlaceholder'])).toBeNull()
  })

})

describe('BindingAction room list', () => {
  const rooms: readonly RoomSummary[] = [
    { roomId: 'faddba2498de6001', name: '打龙战斗协作', members: 0, messages: 18 },
    { roomId: '6ca13d52ca70c883', name: 'binder-probe', members: 3, messages: 4 },
  ]

  it('lists the public rooms when the unbound panel opens', async () => {
    const pending = Promise.withResolvers<RoomListResult>()
    const load = vi.fn(() => pending.promise)
    render(<BindingAction {...props(async () => [], undefined, undefined, load)} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    expect(screen.getAllByText(zh['working']).length).toBeGreaterThan(0)
    await act(async () => { pending.resolve({ ok: true, rooms }) })
    expect(load).toHaveBeenCalledTimes(1)
    // The panel lives in a portal on `document.body`, outside the render container.
    expect(document.body.textContent).toContain('打龙战斗协作')
    expect(document.body.textContent).toContain(zh['rooms.members'].replace('{count}', '3'))
    // The room id labels the row on hover instead of competing with its name.
    expect(screen.getByTitle('faddba2498de6001')).toBeDefined()
  })

  it('reports an empty room list', async () => {
    render(<BindingAction {...props(async () => [], undefined, undefined, async () => ({ ok: true, rooms: [] }))} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await settle()
    expect(screen.getByText(zh['rooms.empty'])).toBeDefined()
  })

  it('enters a listed room directly through the resolver', async () => {
    const resolve = vi.fn<BindingActionProps['resolve']>(async () => ({
      ok: true,
      room: { roomId: 'faddba2498de6001', name: '打龙战斗协作', roomType: 'public', cookie: 'resolved-cookie' },
    }))
    const bind = vi.fn<BindingActionProps['bind']>(async () => ({ ok: true, binding: binding() }))
    render(<BindingAction {...props(
      async () => [], bind, undefined, async () => ({ ok: true, rooms }), { resolve },
    )} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await settle()
    await act(async () => { fireEvent.click(screen.getByTitle('faddba2498de6001')) })
    expect(resolve).toHaveBeenCalledWith({ value: 'faddba2498de6001' })
    expect(bind).toHaveBeenCalledWith({ sessionId: SESSION, cookie: 'resolved-cookie', wake: 'idle-only' })
    expect(screen.getByText(zh['boundAs'].replace('{name}', 'AI-Worker-01'))).toBeDefined()
  })

  it('reports a listed room the resolver cannot resolve', async () => {
    const resolve = vi.fn<BindingActionProps['resolve']>(async () => ({ ok: false, code: 'room-unknown' }))
    const bind = vi.fn<BindingActionProps['bind']>(async () => ({ ok: true, binding: binding() }))
    render(<BindingAction {...props(async () => [], bind, undefined, async () => ({ ok: true, rooms }), { resolve })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await settle()
    await act(async () => { fireEvent.click(screen.getByTitle('faddba2498de6001')) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.room-unknown'])
    // A non-private failure does not open the secondary form.
    expect(screen.queryByPlaceholderText(zh['invitePlaceholder'])).toBeNull()
    expect(bind).not.toHaveBeenCalled()
  })

  it('reports a room the resolver cannot find', async () => {
    const resolve = vi.fn<BindingActionProps['resolve']>(async () => ({ ok: false, code: 'room-unknown' }))
    const bind = vi.fn<BindingActionProps['bind']>(async () => ({ ok: true, binding: binding() }))
    render(<BindingAction {...props(async () => [], bind, undefined, undefined, { resolve })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await openEntry()
    fireEvent.change(screen.getByPlaceholderText(zh['invitePlaceholder']), { target: { value: 'nowhere' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['bind'] })) })
    expect(resolve).toHaveBeenCalledWith({ value: 'nowhere' })
    expect(bind).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(zh['error.room-unknown'])
  })

  it('binds with the access key an invite link carries', async () => {
    const resolve = vi.fn<BindingActionProps['resolve']>(async () => ({
      ok: true,
      room: {
        roomId: 'deadbeefdeadbeef', name: 'private room', roomType: 'private',
        cookie: 'private-cookie', accessKey: 'vk-url',
      },
    }))
    const bind = vi.fn<BindingActionProps['bind']>(async () => ({ ok: true, binding: binding() }))
    render(<BindingAction {...props(async () => [], bind, undefined, undefined, { resolve })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await openEntry()
    const invite = 'https://chat.example.com/room/deadbeefdeadbeef?cookie=private-cookie&key=vk-url'
    fireEvent.change(screen.getByPlaceholderText(zh['invitePlaceholder']), { target: { value: invite } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['bind'] })) })
    expect(resolve).toHaveBeenCalledWith({ value: invite })
    expect(bind).toHaveBeenCalledWith({
      sessionId: SESSION, cookie: 'private-cookie', accessKey: 'vk-url', wake: 'idle-only',
    })
  })

  it('recovers the room list from a failed read', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('gateway down'))
      .mockResolvedValueOnce({ ok: false, code: 'room-unreachable' })
      .mockResolvedValueOnce({ ok: true, rooms: [{ roomId: 'room-1', name: 'Room One', members: 1, messages: 2 }] })
    render(<BindingAction {...props(async () => [], undefined, undefined, load)} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await settle()
    expect(screen.getByText(zh['rooms.failed'])).toBeDefined()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['rooms.refresh'] })) })
    await settle()
    expect(screen.getByText(zh['rooms.failed'])).toBeDefined()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['rooms.refresh'] })) })
    await settle()
    expect(load).toHaveBeenCalledTimes(3)
    expect(screen.getByText('Room One')).toBeDefined()
  })
})

describe('BindingAction bound state', () => {
  it('shows the joined room and unbinds it', async () => {
    const unbind = vi.fn<() => Promise<UnbindResult>>(async () => ({ ok: true, removed: true }))
    const { container } = render(<BindingAction {...props(async () => [binding({ wake: 'always' })], undefined, unbind)} />)
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['trigger.bound'].replace('{name}', 'AI-Worker-01') })) })
    expect(screen.getByText(zh['boundAs'].replace('{name}', 'AI-Worker-01'))).toBeDefined()
    expect(screen.getByText(zh['wake.always'])).toBeDefined()
    expect(container.textContent).not.toContain('cookie')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['unbind'] })) })
    expect(unbind).toHaveBeenCalledWith(SESSION)
    expect(screen.getByRole('button', { name: zh['entry.toggle'] })).toBeDefined()
  })

  it('leaves the room and offers to rejoin while keeping the binding', async () => {
    const leave = vi.fn<BindingActionProps['leave']>(async () => ({ ok: true }))
    const rejoin = vi.fn<BindingActionProps['rejoin']>(async () => ({ ok: false, code: 'not-bound' }))
    const list = vi.fn()
      .mockResolvedValueOnce([binding()])
      .mockResolvedValueOnce([binding()])
      .mockResolvedValue([binding({ status: 'left' })])
    render(<BindingAction {...props(list, undefined, undefined, undefined, { leave, rejoin })} />)
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['trigger.bound'].replace('{name}', 'AI-Worker-01') })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['leave'] })) })
    expect(leave).toHaveBeenCalledWith({ sessionId: SESSION })
    expect(screen.getByText(zh['status.left'])).toBeDefined()
    expect(screen.getByRole('button', { name: zh['rejoin'] })).toBeDefined()
    expect(screen.queryByRole('button', { name: zh['leave'] })).toBeNull()
    // A rejoin without a key carries only the Session, and a refusal keeps the left state visible.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['rejoin'] })) })
    expect(rejoin).toHaveBeenCalledWith({ sessionId: SESSION })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.not-bound'])
    expect(screen.getByText(zh['status.left'])).toBeDefined()
  })

  it('surfaces a refused leave and a thrown leave without losing the binding', async () => {
    const leave = vi.fn<BindingActionProps['leave']>()
      .mockResolvedValueOnce({ ok: false, code: 'room-unreachable' })
      .mockRejectedValueOnce(new Error('offline'))
    render(<BindingAction {...props(async () => [binding()], undefined, undefined, undefined, { leave })} />)
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['trigger.bound'].replace('{name}', 'AI-Worker-01') })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['leave'] })) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.room-unreachable'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['leave'] })) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.generic'])
    expect(screen.getByText(zh['status.active'])).toBeDefined()
  })

  it('surfaces a refused rejoin and a thrown rejoin', async () => {
    const rejoin = vi.fn<BindingActionProps['rejoin']>()
      .mockResolvedValueOnce({ ok: false, code: 'room-rejected' })
      .mockRejectedValueOnce(new Error('offline'))
    render(<BindingAction {...props(async () => [binding({ status: 'left' })], undefined, undefined, undefined, { rejoin })} />)
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['trigger.bound'].replace('{name}', 'AI-Worker-01') })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['rejoin'] })) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.room-rejected'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['rejoin'] })) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.generic'])
    expect(screen.getByText(zh['status.left'])).toBeDefined()
  })

  it('rejoins a left binding with a fresh access key', async () => {
    const rejoin = vi.fn<BindingActionProps['rejoin']>(async () => ({ ok: true, binding: binding() }))
    render(<BindingAction {...props(
      async () => [binding({ status: 'left' })], undefined, undefined, undefined, { rejoin },
    )} />)
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['trigger.bound'].replace('{name}', 'AI-Worker-01') })) })
    expect(screen.getByText(zh['status.left'])).toBeDefined()
    fireEvent.change(screen.getByPlaceholderText(zh['accessKeyPlaceholder']), { target: { value: ' vk-new ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['rejoin'] })) })
    expect(rejoin).toHaveBeenCalledWith({ sessionId: SESSION, accessKey: 'vk-new' })
    expect(screen.getByText(zh['status.active'])).toBeDefined()
  })

  it('opens the bound room page in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<BindingAction {...props(async () => [binding()])} />)
    await settle()
    const bound = screen.getByRole('button', { name: zh['trigger.bound'].replace('{name}', 'AI-Worker-01') })
    await act(async () => { fireEvent.click(bound) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['openRoom'] })) })
    expect(open).toHaveBeenCalledWith(
      'http://127.0.0.1:8200/room/6ca13d52ca70c883', '_blank', 'noopener,noreferrer',
    )
  })

  it('surfaces a rejected unbind instead of clearing the binding', async () => {
    const unbind = vi.fn<() => Promise<UnbindResult>>(async () => ({ ok: false, code: 'declared-binding' }))
    render(<BindingAction {...props(async () => [binding({ source: 'declared' })], undefined, unbind)} />)
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['trigger.bound'].replace('{name}', 'AI-Worker-01') })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['unbind'] })) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.declared-binding'])
    expect(screen.getByText(zh['boundAs'].replace('{name}', 'AI-Worker-01'))).toBeDefined()
  })
})

describe('BindingAction loading', () => {
  it('opens the form on an unreadable first load and reports why', async () => {
    const list = vi.fn(async () => { throw new Error('offline') })
    render(<BindingAction {...props(list)} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.generic'])
    await openEntry()
    expect(screen.getByRole('button', { name: zh['bind'] })).toBeDefined()
  })

  it('keeps a known binding when a refresh fails', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce([binding()])
      .mockRejectedValueOnce(new Error('offline'))
    render(<BindingAction {...props(list)} />)
    await settle()
    const bound = screen.getByRole('button', { name: zh['trigger.bound'].replace('{name}', 'AI-Worker-01') })
    await act(async () => { fireEvent.click(bound) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.generic'])
    expect(screen.getByText(zh['boundAs'].replace('{name}', 'AI-Worker-01'))).toBeDefined()
  })

  it('shows the loading hint when the panel opens before the first read lands', async () => {
    const pending = Promise.withResolvers<readonly BindingView[]>()
    const list = vi.fn(() => pending.promise)
    render(<BindingAction {...props(list)} />)
    await act(async () => { fireEvent.click(trigger()) })
    expect(screen.getByText(zh['working'])).toBeDefined()
    await act(async () => { pending.resolve([]) })
    await openEntry()
    expect(screen.getByRole('button', { name: zh['bind'] })).toBeDefined()
  })

  it('ignores a read that settles after unmount', async () => {
    const resolved = Promise.withResolvers<readonly BindingView[]>()
    const rejected = Promise.withResolvers<readonly BindingView[]>()
    const first = render(<BindingAction {...props(() => resolved.promise)} />)
    first.unmount()
    await act(async () => { resolved.resolve([binding()]) })
    const second = render(<BindingAction {...props(() => rejected.promise)} />)
    second.unmount()
    await act(async () => { rejected.reject(new Error('offline')) })
  })
})

describe('BindingAction interaction', () => {
  it('closes on Escape and on a second trigger press without re-reading', async () => {
    const list = vi.fn(async () => [])
    render(<BindingAction {...props(list)} />)
    await settle()
    const button = trigger()
    await act(async () => { fireEvent.click(button) })
    expect(list).toHaveBeenCalledTimes(2)
    await act(async () => { fireEvent.click(button) })
    expect(screen.queryByText(zh['title'])).toBeNull()
    expect(list).toHaveBeenCalledTimes(2)
    await act(async () => { fireEvent.click(trigger()) })
    button.focus()
    fireEvent.keyDown(button, { key: 'a' })
    expect(screen.getByText(zh['title'])).toBeDefined()
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(screen.queryByText(zh['title'])).toBeNull()
    expect(document.activeElement).toBe(button)
    // Keys pressed while the panel is closed are left to the page.
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(screen.queryByText(zh['title'])).toBeNull()
  })

  it('submits once while the bind is in flight and reflects the pending label', async () => {
    const pending = Promise.withResolvers<BindResult>()
    const bind = vi.fn(() => pending.promise)
    render(<BindingAction {...props(async () => [], bind, undefined, undefined, { resolve: room() })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await openEntry()
    fireEvent.change(screen.getByPlaceholderText(zh['invitePlaceholder']), { target: { value: 'c' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['bind'] })) })
    expect(bind).toHaveBeenCalledTimes(1)
    const working = screen.getByRole('button', { name: zh['working'] })
    expect((working as HTMLButtonElement).disabled).toBe(true)
    // A second programmatic submit while the first is in flight is ignored.
    fireEvent.submit(working.closest('form')!)
    expect(bind).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve({ ok: true, binding: binding() }) })
  })

  it('unbinds once while in flight and reports a thrown unbind', async () => {
    const pending = Promise.withResolvers<UnbindResult>()
    const unbind = vi.fn(() => pending.promise)
    render(<BindingAction {...props(async () => [binding()], undefined, unbind)} />)
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['trigger.bound'].replace('{name}', 'AI-Worker-01') })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['unbind'] })) })
    // Both the leave and unbind actions show the pending label while the unbind is in flight.
    const working = screen.getAllByRole('button', { name: zh['working'] })
    expect(working.every(button => (button as HTMLButtonElement).disabled)).toBe(true)
    expect(unbind).toHaveBeenCalledTimes(1)
    await act(async () => { pending.reject(new Error('offline')) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.generic'])
    expect(screen.getByText(zh['boundAs'].replace('{name}', 'AI-Worker-01'))).toBeDefined()
  })

  it('shows a stopped binding', async () => {
    render(<BindingAction {...props(async () => [binding({ status: 'stopped', source: 'declared' })])} />)
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['trigger.bound'].replace('{name}', 'AI-Worker-01') })) })
    expect(screen.getByText(zh['status.stopped'])).toBeDefined()
    expect(screen.getByText(zh['source.declared'])).toBeDefined()
  })
})

describe('BindingAction service address', () => {
  const endpointToggle = (): HTMLElement => screen.getByRole('button', { name: zh['endpoint.toggle'] })

  it('reads the address on open, saves the trimmed value, and reports the restart', async () => {
    const setEndpoint = vi.fn<BindingActionProps['setEndpoint']>(async request => ({
      ok: true, url: request.url, restartRequired: true,
    }))
    render(<BindingAction {...props(undefined, undefined, undefined, undefined, { setEndpoint })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    // The section stays collapsed until asked, so the panel keeps its original length.
    expect(screen.queryByPlaceholderText(zh['endpoint.placeholder'])).toBeNull()
    await act(async () => { fireEvent.click(endpointToggle()) })
    await settle()
    const input = screen.getByPlaceholderText(zh['endpoint.placeholder']) as HTMLInputElement
    expect(input.value).toBe('http://127.0.0.1:8200/mcp')
    fireEvent.change(input, { target: { value: ' https://bridge.example.com/mcp ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['endpoint.save'] })) })
    expect(setEndpoint).toHaveBeenCalledWith({ url: 'https://bridge.example.com/mcp' })
    expect(screen.getByRole('status').textContent).toBe(zh['endpoint.saved'])
  })

  it('keeps the section visible for a bound Session', async () => {
    render(<BindingAction {...props(async () => [binding()])} />)
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['trigger.bound'].replace('{name}', 'AI-Worker-01') })) })
    expect(endpointToggle()).toBeDefined()
    await act(async () => { fireEvent.click(endpointToggle()) })
    expect(screen.getByPlaceholderText(zh['endpoint.placeholder'])).toBeDefined()
  })

  it('shows an empty field until the address read lands', async () => {
    const pending = Promise.withResolvers<{ url: string }>()
    render(<BindingAction {...props(undefined, undefined, undefined, undefined, { endpoint: () => pending.promise })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await act(async () => { fireEvent.click(endpointToggle()) })
    const input = screen.getByPlaceholderText(zh['endpoint.placeholder']) as HTMLInputElement
    expect(input.value).toBe('')
    expect(screen.getByRole('button', { name: zh['endpoint.save'] })).toHaveProperty('disabled', true)
    await act(async () => { pending.resolve({ url: 'http://127.0.0.1:8200/mcp' }) })
    expect(input.value).toBe('http://127.0.0.1:8200/mcp')
  })

  it('maps a refusal code to its localized copy', async () => {
    const setEndpoint = vi.fn(async () => ({ ok: false as const, code: 'row-missing' as const }))
    render(<BindingAction {...props(undefined, undefined, undefined, undefined, { setEndpoint })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await act(async () => { fireEvent.click(endpointToggle()) })
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['endpoint.save'] })) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.endpoint.row-missing'])
  })

  it('reports thrown saves and failed address reads with the generic copy', async () => {
    const setEndpoint = vi.fn(async () => { throw new Error('offline') })
    const first = render(<BindingAction {...props(undefined, undefined, undefined, undefined, {
      endpoint: async () => { throw new Error('offline') }, setEndpoint,
    })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await act(async () => { fireEvent.click(endpointToggle()) })
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(zh['error.generic'])
    fireEvent.change(screen.getByPlaceholderText(zh['endpoint.placeholder']), { target: { value: 'https://bridge.example.com/mcp' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['endpoint.save'] })) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.generic'])
    first.unmount()
  })

  it('ignores an address read that lands after the panel unmounts', async () => {
    const pending = Promise.withResolvers<{ url: string }>()
    const first = render(<BindingAction {...props(undefined, undefined, undefined, undefined, {
      endpoint: () => pending.promise,
    })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    first.unmount()
    await act(async () => { pending.resolve({ url: 'http://127.0.0.1:8200/mcp' }) })
  })

  it('ignores a failed address read that lands after the panel unmounts', async () => {
    const pending = Promise.withResolvers<{ url: string }>()
    const first = render(<BindingAction {...props(undefined, undefined, undefined, undefined, {
      endpoint: () => pending.promise,
    })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    first.unmount()
    await act(async () => { pending.reject(new Error('offline')) })
  })

  it('ignores a second submit while the save is in flight', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<BindingActionProps['setEndpoint']>>>()
    const setEndpoint = vi.fn(() => pending.promise)
    render(<BindingAction {...props(undefined, undefined, undefined, undefined, { setEndpoint })} />)
    await settle()
    await act(async () => { fireEvent.click(trigger()) })
    await act(async () => { fireEvent.click(endpointToggle()) })
    await settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['endpoint.save'] })) })
    expect(setEndpoint).toHaveBeenCalledTimes(1)
    const working = screen.getByRole('button', { name: zh['working'] })
    expect((working as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(working.closest('form')!)
    expect(setEndpoint).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve({ ok: true, url: 'http://127.0.0.1:8200/mcp', restartRequired: true }) })
  })
})
