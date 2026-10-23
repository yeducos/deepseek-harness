/** Chat-bridge binder behavior: wire parsing, wake delivery, cursors, reconnect, and confinement. */

import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { BindingId } from '../src/brand.ts'
import { chatBridgeBinderDomain } from '../src/storage.ts'
import type { BindingRow } from '../src/storage.ts'
import { parseWireText, truncateBody } from '../src/wire.ts'
import { renderChatBridgeFraming } from '../src/framing.ts'
import { parseAppliedName } from '../src/runtime.ts'
import { parseRoomList } from '../src/rooms.ts'
import { startFakeChatBridge, type FakeChatBridge } from './fake-room.ts'
import { harness } from './harness.ts'
import ChatBridgeBinderService, { type Config } from '../src/index.ts'
import type { DomainFacility, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

const afterEachClose: FakeChatBridge[] = []

/** Start a fake room that the test runner closes afterward. */
async function fakeRoom(preApplied?: readonly string[]): Promise<FakeChatBridge> {
  const fake = await startFakeChatBridge(preApplied === undefined ? {} : { preApplied })
  afterEachClose.push(fake)
  return fake
}

afterEach(async () => {
  for (const fake of afterEachClose.splice(0)) await fake.close()
})

/** Binder config pointed at the fake with fast reconnects and one binding. */
function binderConfig(url: string, overrides: Partial<Config> = {}): Config {
  return {
    url,
    pollWaitSeconds: 1,
    reconnect: { initialDelayMs: 5, maxDelayMs: 20, maxAttempts: 3 },
    bindings: [{ sessionId: 'original', cookie: 'cookie-a' }],
    ...overrides,
  }
}

/** The opened bindings table behind a running harness. */
function table(test: Awaited<ReturnType<typeof harness>>): KvTable<BindingId, BindingRow> {
  const domain = test.ctx.storageDomain.get('chat_bridge_binder')
  if (domain === undefined) throw new Error('binder domain not initialized')
  return domain.table('bindings') as KvTable<BindingId, BindingRow>
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

it('parses the real get_messages wire text', () => {
  const parsed = parseWireText([
    '[新消息]',
    '[1] [AI] 未读 anon-6ca13d (2026-09-04T06:40:26.741369+00:00): 正文首行',
    '正文续行...',
    '[2] [AI] 未读 AI-Worker-01 → AI-Worker-01 (2026-10-21T06:41:20.288275+00:00): 正文',
    '[协作状态] 房间成员: 3 人, 在线: 2 人',
    '[阅读状态] reader=AI-Worker-01 read_through=0 max_message_id=2 unread=2 unread_human=0 attention_required=False',
    '[建议] 轮到你了。',
  ].join('\n'))
  expect(parsed.messages).toEqual([
    { id: 1, sender: 'anon-6ca13d', sentAt: '2026-09-04T06:40:26.741369+00:00', body: '正文首行\n正文续行...' },
    { id: 2, sender: 'AI-Worker-01', target: 'AI-Worker-01', sentAt: '2026-10-21T06:41:20.288275+00:00', body: '正文' },
  ])
  expect(parsed.maxSeenId).toBe(2)
  expect(parsed.unparsedIds).toEqual([])
})

it('parses read marks, broadcast targets, permission markers, and footers', () => {
  const parsed = parseWireText([
    '[新消息]',
    '[3] [真人] 已读 helen (2026-01-01T00:00:00.000+00:00): hello',
    '[4] [AI] 未读 [权限=admin] bob (2026-01-01T00:00:01.000+00:00): hi',
    '[协作状态] 房间成员: 2 人, 在线: 2 人',
  ].join('\n'))
  expect(parsed.messages).toEqual([
    { id: 3, sender: 'helen', sentAt: '2026-01-01T00:00:00.000+00:00', body: 'hello' },
    { id: 4, sender: 'bob', sentAt: '2026-01-01T00:00:01.000+00:00', body: 'hi' },
  ])
  expect(parsed.unparsedIds).toEqual([])
})

it('reports headers that fail field parsing while advancing the cursor', () => {
  const parsed = parseWireText('[新消息]\n[5] [AI] ??? malformed\n[协作状态] 房间成员: 1 人, 在线: 1 人\n')
  expect(parsed.messages).toEqual([])
  expect(parsed.unparsedIds).toEqual([5])
  expect(parsed.maxSeenId).toBe(5)
})

it('treats empty and timeout payloads as no messages', () => {
  expect(parseWireText('[轮询结果] 无新消息，请继续轮询').messages).toEqual([])
  expect(parseWireText('(等待 60 秒无新消息，请继续轮询')).toEqual({
    messages: [], maxSeenId: 0, unparsedIds: [],
  })
})

it('truncates bodies at multi-byte code-point boundaries', () => {
  expect(truncateBody('∞'.repeat(80), 256)).toBe('∞'.repeat(80))
  const marker = '\n[message body truncated at 256 bytes]'
  expect(truncateBody('∞'.repeat(100), 256)).toBe(`${'∞'.repeat(72)}${marker}`)
  const emoji = truncateBody('🙂'.repeat(60), 100)
  expect(emoji).toBe(`${'🙂'.repeat(15)}\n[message body truncated at 100 bytes]`)
  expect(emoji).not.toContain('\uFFFD')
})

it('renders the wake framing verbatim', () => {
  expect(renderChatBridgeFraming('AI-Worker-01', [
    { id: 1, sender: 'AI-Server-01', sentAt: '2026-01-01T00:00:01.000+00:00', body: '你好\n第二行' },
  ])).toBe([
    '[CHAT-BRIDGE MESSAGES]',
    'This is a chat-bridge room message delivered while the Session was idle.',
    'reader: AI-Worker-01',
    'messages_json: [{"id":1,"sender":"AI-Server-01","sentAt":"2026-01-01T00:00:01.000+00:00","body":"你好\\n第二行"}]',
  ].join('\n'))
})

it('extracts the applied name from the apply payload', () => {
  expect(parseAppliedName('{"name":"AI-Worker-01"}')).toBe('AI-Worker-01')
  expect(() => parseAppliedName('not-json')).toThrow('non-JSON payload')
  expect(() => parseAppliedName('{"name":""}')).toThrow('empty room name')
  expect(() => parseAppliedName('{}')).toThrow('no room name')
})

it('parses the real list_rooms text into room rows', () => {
  expect(parseRoomList([
    '公共房间列表：',
    '  room_id=faddba2498de6001 name=打龙战斗协作 members=0 messages=18',
    '  room_id=6ca13d52ca70c883 name=(未命名) members=3 messages=4',
    'noise',
  ].join('\n'))).toEqual([
    { roomId: 'faddba2498de6001', name: '打龙战斗协作', members: 0, messages: 18 },
    { roomId: '6ca13d52ca70c883', name: '(未命名)', members: 3, messages: 4 },
  ])
  expect(parseRoomList('当前无公共房间')).toEqual([])
})

it('wakes the bound Session with the addressed message and commits the cursor', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url) })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  fake.push('AI-Server-01', '你好\n第二行')
  await vi.waitFor(() => { expect(test.agent?.followup).toHaveBeenCalled() })
  const message = test.agent!.followup.mock.calls[0]![0]
  expect(message.role).toBe('user')
  expect(message.source?.kind).toBe('chat-bridge')
  expect(message.content).toEqual([{ type: 'text', text: [
    '[CHAT-BRIDGE MESSAGES]',
    'This is a chat-bridge room message delivered while the Session was idle.',
    'reader: AI-Worker-01',
    'messages_json: [{"id":1,"sender":"AI-Server-01","sentAt":"2026-01-01T00:00:01.000+00:00","body":"你好\\n第二行"}]',
  ].join('\n') }])
  expect(fake.state.applies).toBe(1)
  await vi.waitFor(() => {
    expect(table(test).get(BindingId('original'))).toEqual({
      sessionId: SessionId('original'), agentName: 'AI-Worker-01', cookie: 'cookie-a', since: 1, status: 'active',
      source: 'declared', wake: 'idle-only',
    } satisfies BindingRow)
  })
})

it('delivers a multi-message batch as one followup', async () => {
  const fake = await fakeRoom()
  fake.push('AI-Server-01', 'one')
  fake.push('AI-Server-02', 'two')
  const test = await harness({ agent: 'original', config: binderConfig(fake.url) })
  await vi.waitFor(() => { expect(test.agent?.followup).toHaveBeenCalled() })
  expect(test.agent!.followup).toHaveBeenCalledTimes(1)
  const message = test.agent!.followup.mock.calls[0]![0]
  expect(JSON.parse((message.content[0] as { text: string }).text.split('\nmessages_json: ')[1]!)).toEqual([
    { id: 1, sender: 'AI-Server-01', sentAt: '2026-01-01T00:00:01.000+00:00', body: 'one' },
    { id: 2, sender: 'AI-Server-02', sentAt: '2026-01-01T00:00:02.000+00:00', body: 'two' },
  ])
  await vi.waitFor(() => { expect(table(test).get(BindingId('original'))?.since).toBe(2) })
})

it('resumes from the stored cursor across a restart without redelivery', async () => {
  const fake = await fakeRoom(['AI-Worker-01'])
  const config = binderConfig(fake.url, { bindings: [{ sessionId: 'original', cookie: 'cookie-a', agentName: 'AI-Worker-01' }] })
  const test = await harness({ agent: 'original', config })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  fake.push('AI-Server-01', 'first')
  await vi.waitFor(() => { expect(test.agent?.followup).toHaveBeenCalled() })
  await vi.waitFor(() => { expect(table(test).get(BindingId('original'))?.since).toBe(1) })
  await test.fiber.dispose()
  fake.push('AI-Server-01', 'second')
  await test.ctx.plugin(ChatBridgeBinderService, config)
  await vi.waitFor(() => { expect(test.agent!.followup).toHaveBeenCalledTimes(2) })
  const message = test.agent!.followup.mock.calls[1]![0]
  expect((message.content[0] as { text: string }).text).toContain('"id":2')
  expect((message.content[0] as { text: string }).text).not.toContain('"id":1')
  expect(fake.state.applies).toBe(0)
  await vi.waitFor(() => { expect(table(test).get(BindingId('original'))?.since).toBe(2) })
})

it('upserts declared bindings with declared identity and stored cursor', async () => {
  const fake = await fakeRoom(['AI-Worker-90'])
  const test = await harness({
    agent: 'original',
    config: binderConfig(fake.url, { bindings: [{ sessionId: 'original', cookie: 'cookie-new', agentName: 'AI-Worker-90', since: 1 }] }),
    beforeService: async (_ctx, facility: DomainFacility) => {
      const domain = await facility.open(chatBridgeBinderDomain)
      await domain.table('bindings').put(BindingId('original'), {
        sessionId: SessionId('original'), agentName: 'AI-Worker-01', cookie: 'cookie-old', since: 7, status: 'stopped',
        source: 'declared', wake: 'idle-only',
      })
      await domain.close()
    },
  })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-new')).toBe('AI-Worker-90') })
  expect(table(test).get(BindingId('original'))).toEqual({
    sessionId: SessionId('original'), agentName: 'AI-Worker-90', cookie: 'cookie-new', since: 7, status: 'active',
    source: 'declared', wake: 'idle-only',
  } satisfies BindingRow)
})

it('deletes stored rows whose declaration was removed', async () => {
  const fake = await fakeRoom(['AI-Worker-90'])
  const test = await harness({
    config: binderConfig(fake.url, { bindings: [{ sessionId: 'other', cookie: 'cookie-b' }] }),
    beforeService: async (_ctx, facility: DomainFacility) => {
      const domain = await facility.open(chatBridgeBinderDomain)
      await domain.table('bindings').put(BindingId('original'), {
        sessionId: SessionId('original'), agentName: 'AI-Worker-01', cookie: 'cookie-old', since: 7, status: 'active',
        source: 'declared', wake: 'idle-only',
      })
      await domain.close()
    },
  })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-b')).toBe('AI-Worker-01') })
  expect(table(test).get(BindingId('original'))).toBeUndefined()
  expect(table(test).get(BindingId('other'))?.cookie).toBe('cookie-b')
})

it('falls back to applying for a name when the stored name was never applied', async () => {
  const fake = await fakeRoom()
  const test = await harness({
    agent: 'original',
    config: binderConfig(fake.url, { bindings: [{ sessionId: 'original', cookie: 'cookie-a', agentName: 'Ghost-01' }] }),
  })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  expect(fake.state.applies).toBe(1)
  await vi.waitFor(() => { expect(table(test).get(BindingId('original'))?.agentName).toBe('AI-Worker-01') })
  fake.push('AI-Server-01', 'hello')
  await vi.waitFor(() => { expect(test.agent?.followup).toHaveBeenCalled() })
  expect((test.agent!.followup.mock.calls[0]![0].content[0] as { text: string }).text).toContain('reader: AI-Worker-01')
})

it('reapplies for a name on reconnect when the joined name stops working', async () => {
  const fake = await fakeRoom(['AI-Worker-90'])
  const test = await harness({
    agent: 'original',
    config: binderConfig(fake.url, { bindings: [{ sessionId: 'original', cookie: 'cookie-a', agentName: 'AI-Worker-90' }] }),
  })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-90') })
  fake.faults.terminateSessions = 1
  fake.faults.failJoins = 1
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') }, { timeout: 5000 })
  expect(fake.state.applies).toBe(1)
  await vi.waitFor(() => { expect(table(test).get(BindingId('original'))?.agentName).toBe('AI-Worker-01') })
})

it('recovers from a transient connection failure', async () => {
  const fake = await fakeRoom()
  fake.faults.rejectRequests = 1
  const test = await harness({ agent: 'original', config: binderConfig(fake.url) })
  fake.push('AI-Server-01', 'hello')
  await vi.waitFor(() => { expect(test.agent?.followup).toHaveBeenCalled() })
  await vi.waitFor(() => { expect(table(test).get(BindingId('original'))?.since).toBe(1) })
})

it('gives up after exhausting the reconnect budget', async () => {
  const fake = await fakeRoom()
  fake.faults.rejectRequests = 50
  const logs: unknown[][] = []
  const test = await harness({
    config: binderConfig(fake.url, { reconnect: { initialDelayMs: 2, maxDelayMs: 4, maxAttempts: 2 } }),
    onContext: (ctx) => {
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        vi.spyOn(ctx.logger, level).mockImplementation((...args: unknown[]) => { logs.push(args) })
      }
    },
  })
  await vi.waitFor(() => {
    expect(logs.some(args => String(args[0]).includes('gave up after 2'))).toBe(true)
  })
  const requests = fake.cookies.length
  await tick(80)
  expect(fake.cookies.length).toBe(requests)
  expect(test.agent).toBeUndefined()
  expect(table(test).get(BindingId('original'))).toBeUndefined()
})

it('stops the loop when the bound Session stops and marks the row stopped', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url) })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  await test.ctx.parallel('workspace/session-stop', { sessionId: SessionId('original') })
  expect(table(test).get(BindingId('original'))?.status).toBe('stopped')
  fake.push('AI-Server-01', 'late')
  await tick(300)
  expect(test.agent?.followup).not.toHaveBeenCalled()
})

it('delivers only addressed messages in always mode', async () => {
  const fake = await fakeRoom()
  const test = await harness({
    agent: 'original',
    config: binderConfig(fake.url, {
      bindings: [{ sessionId: 'original', cookie: 'cookie-a', wake: 'always' }],
    }),
  })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  fake.push('AI-Server-01', 'room chatter')
  await vi.waitFor(() => { expect(table(test).get(BindingId('original'))?.since).toBe(1) })
  expect(test.agent?.followup).not.toHaveBeenCalled()
  fake.push('AI-Server-01', 'direct task', 'AI-Worker-01')
  await vi.waitFor(() => { expect(test.agent?.followup).toHaveBeenCalled() })
  const message = test.agent!.followup.mock.calls[0]![0]
  expect(JSON.parse((message.content[0] as { text: string }).text.split('\nmessages_json: ')[1]!)).toEqual([
    { id: 2, sender: 'AI-Server-01', target: 'AI-Worker-01', sentAt: '2026-01-01T00:00:02.000+00:00', body: 'direct task' },
  ])
  await vi.waitFor(() => { expect(table(test).get(BindingId('original'))?.since).toBe(2) })
})

it('keeps polling after a Session stop in always mode so the room can restart it', async () => {
  const fake = await fakeRoom()
  const test = await harness({
    agent: 'original',
    config: binderConfig(fake.url, {
      bindings: [{ sessionId: 'original', cookie: 'cookie-a', wake: 'always' }],
    }),
  })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  await test.ctx.parallel('workspace/session-stop', { sessionId: SessionId('original') })
  expect(table(test).get(BindingId('original'))?.status).toBe('active')
  fake.push('AI-Server-01', 'resume work', 'AI-Worker-01')
  await vi.waitFor(() => { expect(test.agent?.followup).toHaveBeenCalled() })
})

it('rejects an unknown wake mode at load', async () => {
  const fake = await fakeRoom()
  await expect(harness({
    config: { url: fake.url, bindings: [{ sessionId: 'original', cookie: 'cookie-a', wake: 'sometimes' } as never] },
  })).rejects.toThrow()
})

it('rejects structural misconfiguration at load', async () => {
  const fake = await fakeRoom()
  await expect(harness({ config: { url: fake.url, bindings: [{ sessionId: 'original' }] as never } }))
    .rejects.toThrow()
  await expect(harness({ config: { url: 'nope', bindings: [] } })).rejects.toThrow('url must be a valid URL')
  await expect(harness({ config: { url: 'ftp://host/mcp', bindings: [] } })).rejects.toThrow('must use http or https')
  await expect(harness({ config: { url: fake.url, bindings: [{ sessionId: '', cookie: 'a' }] } }))
    .rejects.toThrow('sessionId must not be empty')
  await expect(harness({ config: { url: fake.url, bindings: [{ sessionId: 'original', cookie: '' }] } }))
    .rejects.toThrow('cookie must not be empty')
  await expect(harness({ config: { url: fake.url, bindings: [{ sessionId: 'original', cookie: 'a', agentName: '' }] } }))
    .rejects.toThrow('agentName must not be empty')
  await expect(harness({ config: {
    url: fake.url, bindings: [{ sessionId: 'original', cookie: 'a\nb' }],
  } })).rejects.toThrow('must not contain line breaks')
  await expect(harness({ config: {
    url: fake.url,
    bindings: [
      { sessionId: 'original', cookie: 'a' },
      { sessionId: 'original', cookie: 'b' },
    ],
  } })).rejects.toThrow('bound more than once')
  await expect(harness({ config: binderConfig(fake.url, {
    reconnect: { initialDelayMs: 100, maxDelayMs: 50 },
  }) })).rejects.toThrow('initialDelayMs must be less than or equal to maxDelayMs')
})

it('applies the documented defaults when only the URL is configured', async () => {
  const fake = await fakeRoom()
  const test = await harness({ config: { url: fake.url } })
  await tick(100)
  expect([...table(test).entries()]).toEqual([])
  expect(fake.cookies).toEqual([])
  await test.fiber.dispose()
})

it('applies the defaults for a programmatic construction that bypasses config normalization', async () => {
  const fake = await fakeRoom()
  const test = await harness({
    direct: true,
    config: { url: fake.url, bindings: [{ sessionId: 'original', cookie: 'cookie-a' }] },
  })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  expect(test.service).toBeInstanceOf(ChatBridgeBinderService)
})

it('treats an absent binding list as no bindings without config normalization', async () => {
  const fake = await fakeRoom()
  const test = await harness({ direct: true, config: { url: fake.url } })
  await tick(100)
  expect([...table(test).entries()]).toEqual([])
  expect(fake.requests).toBe(0)
})

it('fails the load and closes the domain when a declared binding cannot be persisted', async () => {
  const fake = await fakeRoom(['AI-Worker-90'])
  const pool = new MemoryMediaPool()
  pool.failNextWrites = 1
  await expect(harness({
    config: binderConfig(fake.url, {
      bindings: [{ sessionId: 'original', cookie: 'cookie-a', agentName: 'AI-Worker-90' }],
    }),
    pool,
  })).rejects.toThrow('injected write failure')
})

it('never leaks the room cookie into logs or model-visible content', async () => {
  const fake = await fakeRoom()
  const logs: unknown[][] = []
  const test = await harness({
    agent: 'original',
    config: binderConfig(fake.url),
    onContext: (ctx) => {
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        vi.spyOn(ctx.logger, level).mockImplementation((...args: unknown[]) => { logs.push(args) })
      }
    },
  })
  fake.faults.rejectRequests = 2
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  fake.push('AI-Server-01', 'hello')
  await vi.waitFor(() => { expect(test.agent?.followup).toHaveBeenCalled() })
  expect(logs.length).toBeGreaterThan(0)
  expect(JSON.stringify(logs)).not.toContain('cookie-a')
  expect((test.agent!.followup.mock.calls[0]![0].content[0] as { text: string }).text).not.toContain('cookie-a')
  expect(fake.cookies.length).toBeGreaterThan(0)
  expect(fake.cookies.every(cookie => cookie === 'cookie-a')).toBe(true)
})

it('retries delivery without a cursor commit when persistence does not acknowledge', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url) })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  let failFirst = false
  test.flush.mockImplementation(async () => {
    if (failFirst) {
      failFirst = false
      throw new Error('Session persistence did not acknowledge')
    }
  })
  failFirst = true
  fake.push('AI-Server-01', 'hello')
  await vi.waitFor(() => { expect(test.agent!.followup).toHaveBeenCalledTimes(2) })
  await vi.waitFor(() => { expect(table(test).get(BindingId('original'))?.since).toBe(1) })
})

it('gives up delivery when the Session cannot be resolved', async () => {
  const fake = await fakeRoom()
  const logs: unknown[][] = []
  const test = await harness({
    config: binderConfig(fake.url, { reconnect: { initialDelayMs: 2, maxDelayMs: 4, maxAttempts: 2 } }),
    onContext: (ctx) => {
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        vi.spyOn(ctx.logger, level).mockImplementation((...args: unknown[]) => { logs.push(args) })
      }
    },
  })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  fake.push('AI-Server-01', 'hello')
  await vi.waitFor(() => {
    expect(logs.some(args => String(args[0]).includes('gave up after 2'))).toBe(true)
  })
  expect(table(test).get(BindingId('original'))?.since).toBe(0)
})

it('reports unparsed headers and advances the cursor without delivery', async () => {
  const fake = await fakeRoom()
  fake.faults.getMessagesText = () => '[新消息]\n[3] [AI] ??? malformed\n[协作状态] 房间成员: 1 人, 在线: 1 人\n'
  const test = await harness({ agent: 'original', config: binderConfig(fake.url) })
  await vi.waitFor(() => { expect(table(test).get(BindingId('original'))?.since).toBe(3) })
  await tick(200)
  expect(test.agent?.followup).not.toHaveBeenCalled()
})

it('aborts an in-flight long poll on disposal', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url) })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  const started = Date.now()
  await test.fiber.dispose()
  expect(Date.now() - started).toBeLessThan(1900)
  expect(test.agent?.followup).not.toHaveBeenCalled()
})

it('skips followup when disposal lands during Session restoration', async () => {
  const fake = await fakeRoom()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const test = await harness({
    agent: 'original',
    config: binderConfig(fake.url),
    resolve: async (sessionId) => {
      await gate
      if (test.agent === undefined) throw new Error('fixture Agent missing')
      if (sessionId !== test.agent.session.id) throw new Error(`Session "${sessionId}" is not the fixture Session`)
      return { agent: test.agent }
    },
  })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  fake.push('AI-Server-01', 'hello')
  await vi.waitFor(() => { expect(vi.mocked(test.resolve).mock.calls.length).toBeGreaterThan(0) })
  const stopping = test.fiber.dispose()
  release?.()
  await stopping
  expect(test.agent?.followup).not.toHaveBeenCalled()
  const reopened = await test.ctx.storageDomain.open(chatBridgeBinderDomain)
  expect(reopened.table('bindings').get(BindingId('original'))?.since).toBe(0)
  await reopened.close()
})

it('fails loud without retrying when reconnect is disabled', async () => {
  const fake = await fakeRoom()
  fake.faults.rejectRequests = 1
  const logs: unknown[][] = []
  const test = await harness({
    config: binderConfig(fake.url, { reconnect: { enabled: false } }),
    onContext: (ctx) => {
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        vi.spyOn(ctx.logger, level).mockImplementation((...args: unknown[]) => { logs.push(args) })
      }
    },
  })
  await vi.waitFor(() => {
    expect(logs.some(args => String(args[0]).includes('reconnect is disabled'))).toBe(true)
  })
  await vi.waitFor(() => { expect(fake.requests).toBe(1) })
  await tick(100)
  expect(fake.requests).toBe(1)
  await test.fiber.dispose()
})

it('aborts a backoff wait when disposal lands mid-retry', async () => {
  const fake = await fakeRoom()
  fake.faults.rejectRequests = 50
  const test = await harness({
    config: binderConfig(fake.url, { reconnect: { initialDelayMs: 30_000, maxDelayMs: 30_000, maxAttempts: 5 } }),
  })
  await vi.waitFor(() => { expect(fake.requests).toBe(1) })
  const started = Date.now()
  await test.fiber.dispose()
  expect(Date.now() - started).toBeLessThan(2000)
})

it('gives up delivery when the Session controller reports an error', async () => {
  const fake = await fakeRoom()
  const logs: unknown[][] = []
  const test = await harness({
    config: binderConfig(fake.url, { reconnect: { initialDelayMs: 2, maxDelayMs: 4, maxAttempts: 1 } }),
    resolve: async () => ({ error: new RemoteError('session/not-found', 'Session is archived', { sessionId: SessionId('original') }) }),
    onContext: (ctx) => {
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        vi.spyOn(ctx.logger, level).mockImplementation((...args: unknown[]) => { logs.push(args) })
      }
    },
  })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  fake.push('AI-Server-01', 'hello')
  await vi.waitFor(() => {
    expect(logs.some(args => String(args[0]).includes('gave up after 1'))).toBe(true)
  })
  expect(table(test).get(BindingId('original'))?.since).toBe(0)
})

it('describes a non-Error failure without assuming an Error type', async () => {
  const fake = await fakeRoom()
  const logs: unknown[][] = []
  const test = await harness({
    config: binderConfig(fake.url, { reconnect: { initialDelayMs: 2, maxDelayMs: 4, maxAttempts: 1 } }),
    resolve: async () => { throw 'room unavailable' },
    onContext: (ctx) => {
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        vi.spyOn(ctx.logger, level).mockImplementation((...args: unknown[]) => { logs.push(args) })
      }
    },
  })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  fake.push('AI-Server-01', 'hello')
  await vi.waitFor(() => {
    expect(logs.some(args => String(args[0]).includes('room unavailable'))).toBe(true)
  })
  expect(test.agent).toBeUndefined()
})

it('reconnects and rejoins after a transport failure during the join handshake', async () => {
  const fake = await fakeRoom(['AI-Worker-90'])
  const test = await harness({
    agent: 'original',
    config: binderConfig(fake.url, { bindings: [{ sessionId: 'original', cookie: 'cookie-a', agentName: 'AI-Worker-90' }] }),
  })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-90') })
  fake.faults.terminateSessions = 1
  fake.faults.textlessJoins = 1
  await vi.waitFor(() => { expect(fake.cookies.length).toBeGreaterThan(2) }, { timeout: 5000 })
  fake.push('AI-Server-01', 'recovered')
  await vi.waitFor(() => { expect(test.agent?.followup).toHaveBeenCalled() })
  expect(fake.state.applies).toBe(0)
  expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-90')
})

it('gives up delivery when persistence never acknowledges the wake', async () => {
  const fake = await fakeRoom()
  const logs: unknown[][] = []
  const test = await harness({
    agent: 'original',
    config: binderConfig(fake.url, { reconnect: { initialDelayMs: 2, maxDelayMs: 4, maxAttempts: 1 } }),
    silentPersistence: true,
    onContext: (ctx) => {
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        vi.spyOn(ctx.logger, level).mockImplementation((...args: unknown[]) => { logs.push(args) })
      }
    },
  })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  fake.push('AI-Server-01', 'hello')
  await vi.waitFor(() => {
    expect(logs.some(args => String(args[0]).includes('did not acknowledge'))).toBe(true)
  })
  expect(table(test).get(BindingId('original'))?.since).toBe(0)
})

it('ignores a session-stop for an unbound Session', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url) })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  await test.ctx.parallel('workspace/session-stop', { sessionId: SessionId('unbound') })
  expect(table(test).get(BindingId('original'))?.status).toBe('active')
})

it('leaves the binding unmarked when its row is already gone', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url) })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  await table(test).delete(BindingId('original'))
  await test.ctx.parallel('workspace/session-stop', { sessionId: SessionId('original') })
  expect(table(test).get(BindingId('original'))).toBeUndefined()
})

it('reports a failure to mark the stopped binding', async () => {
  const fake = await fakeRoom()
  const logs: unknown[][] = []
  const test = await harness({
    agent: 'original',
    config: binderConfig(fake.url),
    onContext: (ctx) => {
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        vi.spyOn(ctx.logger, level).mockImplementation((...args: unknown[]) => { logs.push(args) })
      }
    },
  })
  await vi.waitFor(() => { expect(fake.state.joined.get('cookie-a')).toBe('AI-Worker-01') })
  test.pool.failNextWrites = 1
  await test.ctx.parallel('workspace/session-stop', { sessionId: SessionId('original') })
  expect(logs.some(args => String(args[0]).includes('marking the stopped binding'))).toBe(true)
  expect(table(test).get(BindingId('original'))?.status).toBe('active')
})

it('binds a live Session at runtime without a declaration and wakes it', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url, { bindings: [] }) })
  const result = await test.service.bind({ sessionId: 'original', cookie: 'runtime-cookie' })
  expect(result).toEqual({
    ok: true,
    binding: {
      sessionId: SessionId('original'), agentName: 'AI-Worker-01', since: 0,
      status: 'active', wake: 'idle-only', source: 'runtime',
    },
  })
  expect(table(test).get(BindingId('original'))).toMatchObject({
    cookie: 'runtime-cookie', source: 'runtime', wake: 'idle-only', status: 'active',
  })
  fake.push('AI-Server-01', 'runtime wake')
  await vi.waitFor(() => { expect(test.agent?.followup).toHaveBeenCalledTimes(1) })
  await vi.waitFor(() => { expect(table(test).get(BindingId('original'))?.since).toBe(1) })
})

it('baselines a runtime bind at the room backlog instead of waking with it', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url, { bindings: [] }) })
  fake.push('AI-Server-01', 'before bind')
  const result = await test.service.bind({ sessionId: 'original', cookie: 'runtime-cookie' })
  expect(result).toMatchObject({ ok: true, binding: { since: 1 } })
  expect(table(test).get(BindingId('original'))?.since).toBe(1)
  await tick(1500)
  expect(test.agent?.followup).not.toHaveBeenCalled()
  fake.push('AI-Server-01', 'after bind')
  await vi.waitFor(() => { expect(test.agent?.followup).toHaveBeenCalledTimes(1) })
  const message = test.agent!.followup.mock.calls[0]![0]
  const delivered = (message.content[0] as { text: string }).text
  expect(delivered).toContain('after bind')
  expect(delivered).not.toContain('before bind')
})

it('applies a fresh name when a runtime bind names an unknown member', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url, { bindings: [] }) })
  const result = await test.service.bind({
    sessionId: 'original', cookie: 'runtime-cookie', agentName: 'AI-Worker-07',
  })
  expect(result).toMatchObject({ ok: true, binding: { agentName: 'AI-Worker-01', source: 'runtime' } })
  expect(fake.state.applies).toBe(1)
})

it('lists runtime bindings without exposing the room cookie', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url, { bindings: [] }) })
  await test.service.bind({ sessionId: 'original', cookie: 'secret-cookie', wake: 'always' })
  const rows = await test.service.list()
  expect(rows).toEqual([{
    sessionId: SessionId('original'), agentName: 'AI-Worker-01', since: 0,
    status: 'active', wake: 'always', source: 'runtime',
  }])
  expect(JSON.stringify(rows)).not.toContain('secret-cookie')
})

it('lists public rooms without joining or exposing a credential', async () => {
  const fake = await fakeRoom()
  const test = await harness({ config: binderConfig(fake.url, { bindings: [] }) })
  expect(await test.service.rooms()).toEqual({
    ok: true,
    rooms: [{ roomId: 'faddba2498de6001', name: 'binder-fixture', members: 0, messages: 0 }],
  })
  expect(fake.state.applies).toBe(0)
  expect(fake.state.joined.size).toBe(0)
})

it('reports an unreachable room service when listing rooms', async () => {
  const test = await harness({ config: binderConfig('http://127.0.0.1:1/mcp', { bindings: [], bindTimeoutMs: 2_000 }) })
  expect(await test.service.rooms()).toEqual({ ok: false, code: 'room-unreachable' })
})

it('refuses runtime binds it cannot own', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url) })
  expect(await test.service.bind({ sessionId: 'missing', cookie: 'c' })).toEqual({ ok: false, code: 'session-unknown' })
  expect(await test.service.bind({ sessionId: 'original', cookie: ' ' })).toEqual({ ok: false, code: 'invalid-cookie' })
  expect(await test.service.bind({ sessionId: 'original', cookie: 'c', agentName: ' ' })).toEqual({ ok: false, code: 'invalid-name' })
  expect(await test.service.bind({ sessionId: 'original', cookie: 'c' })).toEqual({ ok: false, code: 'declared-binding' })
  expect(await test.service.unbind({ sessionId: 'original' })).toEqual({ ok: false, code: 'declared-binding' })
  expect(fake.state.applies).toBe(0)
})

it('refuses a runtime bind when the room rejects the handshake', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url, { bindings: [] }) })
  fake.faults.failJoins = 2
  fake.faults.applyResponseText = '{"name":"AI-Worker-99"}'
  expect(await test.service.bind({ sessionId: 'original', cookie: 'c' })).toEqual({ ok: false, code: 'room-rejected' })
  expect(table(test).get(BindingId('original'))).toBeUndefined()
  expect(test.agent?.followup).not.toHaveBeenCalled()
})

it('unbinds a runtime binding and stops awakening the Session', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url, { bindings: [] }) })
  await test.service.bind({ sessionId: 'original', cookie: 'runtime-cookie' })
  fake.push('AI-Server-01', 'first')
  await vi.waitFor(() => { expect(test.agent?.followup).toHaveBeenCalledTimes(1) })
  expect(await test.service.unbind({ sessionId: 'original' })).toEqual({ ok: true, removed: true })
  expect(table(test).get(BindingId('original'))).toBeUndefined()
  fake.push('AI-Server-01', 'second')
  await tick(1500)
  expect(test.agent?.followup).toHaveBeenCalledTimes(1)
})

it('keeps runtime bindings across a reload and drops removed declarations only', async () => {
  const fake = await fakeRoom()
  const config = binderConfig(fake.url, {
    bindings: [{ sessionId: 'other', cookie: 'cookie-b', agentName: 'AI-Worker-90' }],
  })
  const test = await harness({ agent: 'original', config })
  await test.service.bind({ sessionId: 'original', cookie: 'runtime-cookie' })
  fake.push('AI-Server-01', 'first')
  await vi.waitFor(() => { expect(test.agent?.followup).toHaveBeenCalledTimes(1) })
  await test.fiber.dispose()
  fake.push('AI-Server-01', 'second')
  await test.ctx.plugin(ChatBridgeBinderService, config)
  await vi.waitFor(() => { expect(test.agent!.followup).toHaveBeenCalledTimes(2) })
  const message = test.agent!.followup.mock.calls[1]![0]
  expect((message.content[0] as { text: string }).text).toContain('"id":2')
  expect(table(test).get(BindingId('original'))).toMatchObject({ source: 'runtime', cookie: 'runtime-cookie' })
  expect(table(test).get(BindingId('other'))).toMatchObject({ source: 'declared' })
})

it('rejoins a room name that was already applied instead of claiming a new one', async () => {
  const fake = await fakeRoom(['AI-Worker-07'])
  const test = await harness({ agent: 'original', config: binderConfig(fake.url, { bindings: [] }) })
  const result = await test.service.bind({ sessionId: 'original', cookie: 'runtime-cookie', agentName: 'AI-Worker-07' })
  expect(result).toMatchObject({ ok: true, binding: { agentName: 'AI-Worker-07', source: 'runtime' } })
  expect(fake.state.applies).toBe(0)
  expect(fake.state.joined.get('runtime-cookie')).toBe('AI-Worker-07')
})

it('reports an unreachable room without landing the binding', async () => {
  const test = await harness({ agent: 'original', config: binderConfig('http://127.0.0.1:1/mcp', { bindings: [], bindTimeoutMs: 2_000 }) })
  expect(await test.service.bind({ sessionId: 'original', cookie: 'c' })).toEqual({ ok: false, code: 'room-unreachable' })
  expect(table(test).get(BindingId('original'))).toBeUndefined()
})

it('treats empty identities as no-ops', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url, { bindings: [] }) })
  expect(await test.service.bind({ sessionId: ' ', cookie: 'c' })).toEqual({ ok: false, code: 'session-unknown' })
  expect(await test.service.unbind({ sessionId: ' ' })).toEqual({ ok: true, removed: false })
  expect(await test.service.unbind({ sessionId: 'unbound' })).toEqual({ ok: true, removed: false })
})

it('resolves a room id and an invite link without landing a binding', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url, { bindings: [] }) })
  expect(await test.service.resolve({ value: 'faddba2498de6001' })).toEqual({
    ok: true,
    room: {
      roomId: 'faddba2498de6001', name: 'binder-fixture', roomType: 'public', cookie: 'fixture-cookie',
    },
  })
  expect(await test.service.resolve({
    value: 'https://chat.example.com/room/faddba2498de6001?cookie=fixture-cookie',
  })).toEqual({
    ok: true,
    room: {
      roomId: 'faddba2498de6001', name: 'binder-fixture', roomType: 'public', cookie: 'fixture-cookie',
    },
  })
  expect(await test.service.resolve({ value: ' ' })).toEqual({ ok: false, code: 'invalid-value' })
  expect(await test.service.resolve({ value: 'nowhere' })).toEqual({ ok: false, code: 'room-unknown' })
  expect(table(test).get(BindingId('original'))).toBeUndefined()
  expect(fake.state.joined.size).toBe(0)
})

it('requires an access key for a private room and returns the key an invite link carries', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url, { bindings: [] }) })
  expect(await test.service.resolve({ value: 'deadbeefdeadbeef' })).toEqual({ ok: false, code: 'room-private' })
  expect(await test.service.resolve({ value: 'deadbeefdeadbeef', accessKey: 'wrong' }))
    .toEqual({ ok: false, code: 'room-private' })
  expect(await test.service.resolve({ value: 'deadbeefdeadbeef', accessKey: 'vk-test' })).toMatchObject({
    ok: true, room: { cookie: 'fixture-private', roomType: 'private' },
  })
  expect(await test.service.resolve({
    value: 'https://chat.example.com/room/deadbeefdeadbeef?cookie=fixture-private&key=vk-test',
  })).toMatchObject({ ok: true, room: { cookie: 'fixture-private', accessKey: 'vk-test' } })
  expect(await test.service.bind({
    sessionId: 'original', cookie: 'fixture-private', accessKey: 'vk-test',
  })).toMatchObject({ ok: true, binding: { source: 'runtime' } })
})

it('leaves the room, keeps the binding, and stops waking the Session', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url, { bindings: [] }) })
  await test.service.bind({ sessionId: 'original', cookie: 'runtime-cookie' })
  fake.push('AI-Server-01', 'first')
  await vi.waitFor(() => { expect(test.agent?.followup).toHaveBeenCalledTimes(1) })
  expect(await test.service.leave({ sessionId: 'original' })).toEqual({ ok: true })
  expect(fake.state.leftNames).toEqual(['AI-Worker-01'])
  expect(table(test).get(BindingId('original'))).toMatchObject({ status: 'left', cookie: 'runtime-cookie' })
  fake.push('AI-Server-01', 'second')
  await tick(1200)
  expect(test.agent?.followup).toHaveBeenCalledTimes(1)
  expect(await test.service.leave({ sessionId: 'original' })).toEqual({ ok: true })
  expect(await test.service.leave({ sessionId: 'unbound' })).toEqual({ ok: false, code: 'not-bound' })
  expect(await test.service.leave({ sessionId: ' ' })).toEqual({ ok: false, code: 'session-unknown' })
})

it('rejoins a left binding from the current backlog without replaying the gap', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url, { bindings: [] }) })
  await test.service.bind({ sessionId: 'original', cookie: 'runtime-cookie' })
  fake.push('AI-Server-01', 'before leave')
  await vi.waitFor(() => { expect(test.agent?.followup).toHaveBeenCalledTimes(1) })
  await test.service.leave({ sessionId: 'original' })
  fake.push('AI-Server-01', 'while away')
  expect(await test.service.rejoin({ sessionId: 'original' })).toMatchObject({
    ok: true, binding: { status: 'active', since: 2 },
  })
  await tick(1200)
  expect(test.agent?.followup).toHaveBeenCalledTimes(1)
  fake.push('AI-Server-01', 'after rejoin')
  await vi.waitFor(() => { expect(test.agent?.followup).toHaveBeenCalledTimes(2) })
  const message = test.agent!.followup.mock.calls[1]![0]
  expect((message.content[0] as { text: string }).text).toContain('after rejoin')
})

it('refuses to rejoin a binding that did not leave', async () => {
  const fake = await fakeRoom()
  const test = await harness({ agent: 'original', config: binderConfig(fake.url, { bindings: [] }) })
  await test.service.bind({ sessionId: 'original', cookie: 'runtime-cookie' })
  expect(await test.service.rejoin({ sessionId: 'original' })).toEqual({ ok: false, code: 'not-left' })
  expect(await test.service.rejoin({ sessionId: 'unbound' })).toEqual({ ok: false, code: 'not-bound' })
  expect(await test.service.rejoin({ sessionId: ' ' })).toEqual({ ok: false, code: 'session-unknown' })
})

it('does not restart a left runtime binding after a reload', async () => {
  const fake = await fakeRoom()
  const config = binderConfig(fake.url, { bindings: [] })
  const test = await harness({ agent: 'original', config })
  await test.service.bind({ sessionId: 'original', cookie: 'runtime-cookie' })
  await test.service.leave({ sessionId: 'original' })
  await test.fiber.dispose()
  await test.ctx.plugin(ChatBridgeBinderService, config)
  await vi.waitFor(() => { expect(table(test).get(BindingId('original'))?.status).toBe('left') })
  fake.push('AI-Server-01', 'after reload')
  await tick(1500)
  expect(test.agent?.followup).not.toHaveBeenCalled()
})

it('orders listed bindings by Session without reading room cookies', async () => {
  const fake = await fakeRoom()
  const test = await harness({
    agent: 'original',
    config: binderConfig(fake.url, { bindings: [{ sessionId: 'other', cookie: 'cookie-b', agentName: 'AI-Worker-90' }] }),
  })
  await test.service.bind({ sessionId: 'original', cookie: 'runtime-cookie' })
  const rows = await test.service.list()
  expect(rows.map(row => row.sessionId)).toEqual([SessionId('original'), SessionId('other')])
  expect(JSON.stringify(rows)).not.toContain('runtime-cookie')
})
