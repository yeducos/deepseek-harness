/** Durable Session-to-room bindings for the chat-bridge binder. */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { BindingId, NameMemoryId } from './brand.ts'

/**
 * Stored binding: one bound Session, its room credential, joined name, cursor,
 * wake scope, and where the binding came from. Rows written before `source`
 * and `wake` existed parse as declared `idle-only` bindings, which is what
 * every such row was.
 */
export const bindingRowSchema = z.object({
  sessionId: z.string().min(1).transform(SessionId),
  agentName: z.string().min(1),
  cookie: z.string().min(1),
  since: z.number().int().min(0),
  status: z.enum(['active', 'stopped', 'left']).default('active'),
  source: z.enum(['declared', 'runtime']).default('declared'),
  wake: z.enum(['idle-only', 'always']).default('idle-only'),
}).strict()

/** Persisted binding row. */
export type BindingRow = z.infer<typeof bindingRowSchema>

/**
 * Remembered join name for one Session in one room. The row outlives the
 * binding so re-binding after an unbind joins under the same member name
 * instead of claiming a new one.
 */
export const nameMemoryRowSchema = z.object({
  agentName: z.string().min(1),
}).strict()

/** Persisted name-memory row. */
export type NameMemoryRow = z.infer<typeof nameMemoryRowSchema>

/** Authoritative binder storage; malformed rows reject opening the domain. */
export const chatBridgeBinderDomain = defineDomain({
  // The `left` status widens an enum inside unchanged JSON, and the `names`
  // table only adds an absent-on-read table, so the medium format keeps its
  // version: the single layout rejects any stored version it did not write.
  name: 'chat_bridge_binder', version: 1,
  tables: {
    bindings: domainTable<BindingId, BindingRow>(bindingRowSchema),
    names: domainTable<NameMemoryId, NameMemoryRow>(nameMemoryRowSchema),
  },
})
