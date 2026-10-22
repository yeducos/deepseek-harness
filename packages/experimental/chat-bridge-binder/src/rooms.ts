/**
 * Public-room discovery for the binding form. The `list_rooms` tool returns
 * plain text (`room_id=… name=… members=… messages=…`) and never a credential,
 * so the listing locates a room but cannot substitute for its cookie.
 *
 * @module
 */

import { BridgeConnection } from './mcp.ts'
import type { RoomListResult, RoomSummary } from './types.ts'

/** One room line from the `list_rooms` payload. */
const ROOM_LINE = /^\s*room_id=(\S+)\s+name=(.*?)\s+members=(\d+)\s+messages=(\d+)\s*$/

/**
 * Parse one `list_rooms` text payload.
 * @param text - Exact text from the tool's first content block.
 * @returns Rooms in server order; the header, empty-list notice, and any unrecognized lines are skipped.
 */
export function parseRoomList(text: string): readonly RoomSummary[] {
  const rooms: RoomSummary[] = []
  for (const line of text.split('\n')) {
    const match = ROOM_LINE.exec(line)
    if (match === null) continue
    /* v8 ignore next 2 -- the fallbacks satisfy noUncheckedIndexedAccess for groups a match always carries. */
    rooms.push({
      roomId: match[1] ?? '', name: match[2] ?? '', members: Number(match[3]), messages: Number(match[4]),
    })
  }
  return rooms
}

/**
 * Read the public room list once through a credential-free connection.
 * @param url - chat-bridge MCP Streamable HTTP endpoint.
 * @param timeoutMs - Bound on the connect and list calls.
 * @returns the rooms, or that the room service could not be reached.
 */
export async function listRooms(url: string, timeoutMs: number): Promise<RoomListResult> {
  const connection = new BridgeConnection(url, '')
  try {
    await connection.connect()
    const text = await connection.call('list_rooms', {}, timeoutMs, new AbortController().signal)
    return { ok: true, rooms: parseRoomList(text) }
  } catch {
    return { ok: false, code: 'room-unreachable' }
  } finally {
    await connection.close()
  }
}
