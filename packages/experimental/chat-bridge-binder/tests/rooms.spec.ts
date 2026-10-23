import { afterEach, expect, it } from 'vitest'
import { leaveRoom, listRooms, resolveRoom, roomPageUrl } from '../src/rooms.ts'
import { startFakeChatBridge, type FakeChatBridge, type FakeChatBridgeOptions } from './fake-room.ts'

/** Servers started by a test, closed together afterwards. */
const servers: FakeChatBridge[] = []

/** Start one fake room and keep it for teardown. */
async function room(options: FakeChatBridgeOptions = {}): Promise<FakeChatBridge> {
  const fake = await startFakeChatBridge(options)
  servers.push(fake)
  return fake
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
})

/** Bound on each connect and tool call. */
const TIMEOUT = 2_000

/** The room the fake lists and resolves without a credential. */
const PUBLIC_ROOM = {
  roomId: 'faddba2498de6001', name: 'binder-fixture', roomType: 'public' as const, cookie: 'fixture-cookie',
}

it('derives the room page from the endpoint origin and the cookie hash', () => {
  expect(roomPageUrl('http://127.0.0.1:8200/mcp', 'abc123'))
    .toBe('http://127.0.0.1:8200/room/6ca13d52ca70c883')
})

it('lists public rooms and reports an unreachable service', async () => {
  const fake = await room()
  expect(await listRooms(fake.url, TIMEOUT)).toEqual({
    ok: true,
    rooms: [{ roomId: PUBLIC_ROOM.roomId, name: PUBLIC_ROOM.name, members: 0, messages: 0 }],
  })
  expect(await listRooms('http://127.0.0.1:1/mcp', TIMEOUT)).toEqual({ ok: false, code: 'room-unreachable' })
})

it('resolves public and private rooms through the server tool', async () => {
  const fake = await room()
  expect(await resolveRoom(fake.url, PUBLIC_ROOM.roomId, undefined, TIMEOUT))
    .toEqual({ ok: true, room: PUBLIC_ROOM })
  expect(await resolveRoom(fake.url, 'deadbeefdeadbeef', 'vk-test', TIMEOUT)).toMatchObject({
    ok: true, room: { roomId: 'deadbeefdeadbeef', roomType: 'private', cookie: 'fixture-private' },
  })
  expect(await resolveRoom(fake.url, 'deadbeefdeadbeef', undefined, TIMEOUT))
    .toEqual({ ok: false, code: 'room-private' })
  expect(await resolveRoom(fake.url, 'deadbeefdeadbeef', 'wrong', TIMEOUT))
    .toEqual({ ok: false, code: 'room-private' })
  expect(await resolveRoom(fake.url, 'nowhere', undefined, TIMEOUT))
    .toEqual({ ok: false, code: 'room-unknown' })
})

it('maps an invalid-value refusal onto the form category', async () => {
  const fake = await room({ resolveText: () => '[错误] invalid-value: 请填写房间引用' })
  expect(await resolveRoom(fake.url, ' ', undefined, TIMEOUT)).toEqual({ ok: false, code: 'invalid-value' })
})

it('rejects every malformed resolution payload as unreachable', async () => {
  let payload = 'not-json'
  const fake = await room({ resolveText: () => payload })
  const malformed = [
    'not-json',
    'null',
    '[]',
    '{}',
    '{"room_id":"r","room_name":7,"room_type":"public","cookie":"c"}',
    '{"room_id":"r","room_name":"n","room_type":"chat","cookie":"c"}',
    '{"room_id":"r","room_name":"n","room_type":"public"}',
    '{"room_id":"r","room_name":"n","room_type":"public","cookie":"c","access_key":"a\\nb"}',
  ]
  for (const value of malformed) {
    payload = value
    expect(await resolveRoom(fake.url, 'r', undefined, TIMEOUT)).toEqual({ ok: false, code: 'room-unreachable' })
  }
})

it('distinguishes a tool refusal, a missing resolver, and an unreachable service', async () => {
  const refusing = await room({ resolveError: 'resolve_room rejected the reference' })
  expect(await resolveRoom(refusing.url, 'r', undefined, TIMEOUT)).toEqual({ ok: false, code: 'room-unknown' })

  const legacy = await room({ omitResolve: true })
  expect(await resolveRoom(legacy.url, 'r', undefined, TIMEOUT))
    .toEqual({ ok: false, code: 'resolution-unsupported' })

  const offline = await room()
  offline.faults.rejectRequests = 1
  expect(await resolveRoom(offline.url, 'r', undefined, TIMEOUT)).toEqual({ ok: false, code: 'room-unreachable' })
})

it('leaves a member through the room tool and reports an unreachable service', async () => {
  const fake = await room()
  expect(await leaveRoom(fake.url, 'fixture-cookie', 'AI-Worker-01', TIMEOUT)).toEqual({ ok: true })
  expect(fake.state.leftNames).toEqual(['AI-Worker-01'])
  fake.faults.rejectRequests = 1
  expect(await leaveRoom(fake.url, 'fixture-cookie', 'AI-Worker-01', TIMEOUT))
    .toEqual({ ok: false, reason: 'unreachable' })
  expect(await leaveRoom('http://127.0.0.1:1/mcp', 'fixture-cookie', 'AI-Worker-01', TIMEOUT))
    .toEqual({ ok: false, reason: 'unreachable' })
})
