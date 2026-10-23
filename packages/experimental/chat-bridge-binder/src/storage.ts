/** Durable Session-to-room bindings for the chat-bridge binder. */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { BindingId } from './brand.ts'

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

/** Authoritative binder storage; malformed rows reject opening the domain. */
export const chatBridgeBinderDomain = defineDomain({
  // The `left` status widens an enum inside unchanged JSON, so the medium format
  // keeps its version: the single layout rejects any stored version it did not write.
  name: 'chat_bridge_binder', version: 1,
  tables: { bindings: domainTable<BindingId, BindingRow>(bindingRowSchema) },
})
