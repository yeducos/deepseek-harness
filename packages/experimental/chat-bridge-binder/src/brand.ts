/** Opaque chat-bridge binder identities. */

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
