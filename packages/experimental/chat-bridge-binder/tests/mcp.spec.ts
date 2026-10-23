/** Per-binding MCP connection lifecycle: call-before-connect, connect, and idempotent close. */

import { afterEach, expect, it } from 'vitest'
import { BridgeConnection } from '../src/mcp.ts'
import { startFakeChatBridge, type FakeChatBridge } from './fake-room.ts'

const rooms: FakeChatBridge[] = []

afterEach(async () => {
  for (const room of rooms.splice(0)) await room.close()
})

it('rejects a call before a connection exists', async () => {
  const connection = new BridgeConnection('http://127.0.0.1:9/mcp', 'cookie-a')
  await expect(connection.call('get_messages', {}, 1000, new AbortController().signal))
    .rejects.toThrow('connection is not established')
  expect(connection.connected).toBe(false)
})

it('closes a connected generation and tolerates closing without one', async () => {
  const room = await startFakeChatBridge()
  rooms.push(room)
  const connection = new BridgeConnection(room.url, 'cookie-a')
  await connection.close()
  expect(connection.connected).toBe(false)
  await connection.connect()
  expect(connection.connected).toBe(true)
  await connection.close()
  expect(connection.connected).toBe(false)
})
