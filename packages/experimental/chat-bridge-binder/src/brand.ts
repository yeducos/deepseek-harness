/** Opaque chat-bridge binder identities. */

import { createHash } from 'node:crypto'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one durable Session-to-room binding row. */
export type BindingId = Branded<'BindingId'>

/**
 * Binding storage key for one bound Session; the key exists independently of
 * whether the row has a joined name yet.
 * @param sessionId - Session the binding wakes.
 * @returns the storage key carrying its compile-time brand.
 */
export function BindingId(sessionId: string): BindingId {
  return `chat-bridge-${sessionId}` as BindingId
}

/**
 * Identifies the remembered join name of one Session in one room. The cookie
 * names the room, so its hash keeps the credential out of a second table.
 */
export type NameMemoryId = Branded<'NameMemoryId'>

/**
 * Name-memory storage key for one Session in one room.
 * @param sessionId - Session the remembered name belongs to.
 * @param cookie - Room credential identifying the room.
 * @returns the hashed storage key carrying its compile-time brand.
 */
export function NameMemoryId(sessionId: string, cookie: string): NameMemoryId {
  return `chat-bridge-name-${createHash('sha256').update(`${sessionId}\u0000${cookie}`).digest('hex')}` as NameMemoryId
}
