/**
 * Room discovery for the binding form. The `list_rooms` tool returns plain
 * text (`room_id=… name=… members=… messages=…`) and never a credential, so
 * selecting a listed room resolves it through `resolve_room`; invite links,
 * room ids, and cookies all take that same path. Leaving a room is the only
 * other membership operation here.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { BridgeConnection, BridgeToolError } from './mcp.ts'
import type {
  ResolvedRoom, ResolveFailureCode, ResolveResult, RoomListResult, RoomSummary,
} from './types.ts'

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
 * Web page for the room a cookie opens. The service derives a room's id from
 * the first 16 hexadecimal characters of its cookie's SHA-256 and serves the
 * WebUI under the MCP endpoint's origin, so the page needs no credential.
 * @param url - chat-bridge MCP Streamable HTTP endpoint.
 * @param cookie - Room credential whose room page is wanted.
 * @returns Absolute WebUI URL of that room.
 */
export function roomPageUrl(url: string, cookie: string): string {
  const roomId = createHash('sha256').update(cookie, 'utf8').digest('hex').slice(0, 16)
  return new URL(`/room/${roomId}`, new URL(url).origin).toString()
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

/** Leading error code the chat-bridge server puts on a refused `resolve_room` call. */
const ERROR_CODE = /^\[错误\]\s*([a-z][a-z-]*):/

/** Map one server-side resolve failure code onto the form's categories. */
function failureOf(code: string): ResolveFailureCode {
  switch (code) {
    case 'invalid-value': return 'invalid-value'
    case 'room-private':
    case 'access-key-invalid': return 'room-private'
    default: return 'room-unknown'
  }
}

/** Field checks for the `resolve_room` payload, which arrives from another process. */
function readResolvedRoom(text: string): ResolvedRoom | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const {
    room_id: roomId, room_name: name, room_type: roomType, cookie, access_key: accessKey,
  } = parsed as Record<string, unknown>
  if (typeof roomId !== 'string' || roomId.length === 0) return undefined
  if (typeof name !== 'string') return undefined
  if (roomType !== 'public' && roomType !== 'private') return undefined
  if (typeof cookie !== 'string' || cookie.length === 0) return undefined
  if (accessKey !== undefined && (typeof accessKey !== 'string' || /[\r\n]/.test(accessKey))) return undefined
  return { roomId, name, roomType, cookie, ...(accessKey === undefined ? {} : { accessKey }) }
}

/**
 * Resolve one invite link, room id (prefix allowed), or room cookie with the
 * server's `resolve_room` tool. The returned cookie is the room credential the
 * bind handshake needs; a private room answers only under a valid access key.
 * @param url - chat-bridge MCP Streamable HTTP endpoint.
 * @param value - Invite URL, room id, or room cookie as entered in the form.
 * @param accessKey - Access key for a private room, when the form supplies one.
 * @param timeoutMs - Bound on the connect and resolve calls.
 * @returns the room and its cookie, or the refusal category without credential material.
 */
export async function resolveRoom(
  url: string,
  value: string,
  accessKey: string | undefined,
  timeoutMs: number,
): Promise<ResolveResult> {
  const connection = new BridgeConnection(url, '')
  try {
    await connection.connect()
    const text = await connection.call(
      'resolve_room',
      accessKey === undefined ? { value } : { value, access_key: accessKey },
      timeoutMs,
      new AbortController().signal,
    )
    const failure = ERROR_CODE.exec(text.trim())
    if (failure !== null) {
      /* v8 ignore next -- group 1 always matches when the pattern matches. */
      return { ok: false, code: failureOf(failure[1] ?? '') }
    }
    const room = readResolvedRoom(text)
    return room === undefined ? { ok: false, code: 'room-unreachable' } : { ok: true, room }
  } catch (error) {
    // An older server has no `resolve_room`; say so instead of blaming the network.
    if (!(error instanceof BridgeToolError) && error instanceof Error && error.message.includes('resolve_room')) {
      return { ok: false, code: 'resolution-unsupported' }
    }
    if (error instanceof BridgeToolError) return { ok: false, code: 'room-unknown' }
    return { ok: false, code: 'room-unreachable' }
  } finally {
    await connection.close()
  }
}

/** Leave-room outcome: the member is gone, or the room service could not be reached. */
export type LeaveRoomResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unreachable' }

/**
 * Remove one bound member from its room. Leaving is idempotent on the server;
 * a member that is already gone still answers with a normal text result.
 * @param url - chat-bridge MCP Streamable HTTP endpoint.
 * @param cookie - room credential for the connection headers.
 * @param name - member to remove; the name the binding joined under.
 * @param timeoutMs - Bound on the connect and leave calls.
 * @returns whether the server accepted the leave, without credential material.
 */
export async function leaveRoom(
  url: string,
  cookie: string,
  name: string,
  timeoutMs: number,
): Promise<LeaveRoomResult> {
  const connection = new BridgeConnection(url, cookie)
  try {
    await connection.connect()
    await connection.call('leave_room', { name }, timeoutMs, new AbortController().signal)
    return { ok: true }
  } catch {
    return { ok: false, reason: 'unreachable' }
  } finally {
    await connection.close()
  }
}
