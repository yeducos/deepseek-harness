/** Shared binder types: configuration, wire messages, and parsed room output. */

/** Automatic reconnect policy for one binding's MCP connection. */
export interface ReconnectConfig {
  /** Reconnect automatically after a lost connection (default true). */
  enabled?: boolean
  /** First reconnect delay in milliseconds; doubles per consecutive failed attempt (default 500). */
  initialDelayMs?: number
  /** Backoff ceiling in milliseconds (default 30000). */
  maxDelayMs?: number
  /** Consecutive failed attempts before the loop gives up until reload (default 10). */
  maxAttempts?: number
}

/**
 * Which room messages may wake the bound Session.
 *
 * `idle-only` delivers every visible room message but stops watching when the
 * Session is explicitly stopped. `always` keeps watching after a stop and
 * delivers only messages addressed to the bound member.
 */
export type WakeMode = 'idle-only' | 'always'

/** One declared Session-to-room binding in cordis.yml. */
export interface BindingConfig {
  /** Session the room message wake delivers into. */
  sessionId: string
  /** Room credential sent as the `Cookie: room=` header; never logged or stored elsewhere. */
  cookie: string
  /** Room name to join; omission applies for one on the first connect. */
  agentName?: string
  /** Initial cursor used when no stored row exists (default 0). */
  since?: number
  /** Wake scope for this binding (default `idle-only`). */
  wake?: WakeMode
}

/** Configuration for the chat-bridge binder plugin. */
export interface Config {
  /** chat-bridge MCP Streamable HTTP endpoint, such as `http://host:8200/mcp`. */
  url: string
  /** Long-poll duration per get_messages call, in seconds (default 60). */
  pollWaitSeconds?: number
  /** Per-message UTF-8 byte budget applied before delivery (default 16384). */
  maxMessageBytes?: number
  /** Bound on each room handshake or room-list request the runtime API performs (default 15000 ms). */
  bindTimeoutMs?: number
  /** Reconnect policy after a failed or lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
  /** Durable Session-to-room bindings; removal of one deletes its stored row. */
  bindings?: BindingConfig[]
}

/** Where one binding came from: the deployment's cordis.yml or a live Session. */
export type BindingSource = 'declared' | 'runtime'

/**
 * Whether a binding is watching its room. `left` records that the bound member
 * left the room; the binding survives so the Session can rejoin later.
 */
export type BindingStatus = 'active' | 'stopped' | 'left'

/**
 * One binding as the runtime API reports it. The room cookie stays in the
 * durable row and in connection headers; it never appears here.
 */
export interface BindingView {
  /** Bound Session identity. */
  readonly sessionId: string
  /** Room name the binding joined, or applied for on its first connect. */
  readonly agentName: string
  /** Cursor the next poll starts from. */
  readonly since: number
  /** Whether the binding is currently watching the room. */
  readonly status: BindingStatus
  /** Wake scope. */
  readonly wake: WakeMode
  /** Declaration source. */
  readonly source: BindingSource
}

/** Bind one live Session to a room at runtime. */
export interface BindRequest {
  /** Session to bind; it must be loaded in this Host. */
  readonly sessionId: string
  /** Room credential; validated against the room before the binding lands. */
  readonly cookie: string
  /** Existing room name to rejoin; omission applies for one. */
  readonly agentName?: string
  /** Access key a private room requires for the first join. */
  readonly accessKey?: string
  /** Wake scope for this binding (default `idle-only`). */
  readonly wake?: WakeMode
}

/** Why a runtime bind was refused. */
export type BindFailureCode =
  | 'session-unknown'
  | 'invalid-cookie'
  | 'invalid-name'
  | 'declared-binding'
  | 'room-unreachable'
  | 'room-rejected'

/** Runtime bind outcome. */
export type BindResult =
  | { readonly ok: true; readonly binding: BindingView }
  | { readonly ok: false; readonly code: BindFailureCode }

/** Remove one runtime binding. */
export interface UnbindRequest {
  /** Session whose runtime binding is removed. */
  readonly sessionId: string
}

/** Runtime unbind outcome; `removed` is false when no row existed. */
export type UnbindResult =
  | { readonly ok: true; readonly removed: boolean }
  | { readonly ok: false; readonly code: 'declared-binding' }

/** Resolve one invite link, room id, or room cookie into a joinable room. */
export interface ResolveRequest {
  /** WebUI invite URL, room id (prefix allowed), or room cookie. */
  readonly value: string
  /** Access key for a private room; an invite URL's key parameter also works. */
  readonly accessKey?: string
}

/** One room the resolver located, including the credential the bind needs. */
export interface ResolvedRoom {
  /** Stable room id; a room cookie hashes to this value. */
  readonly roomId: string
  /** Room name, or the server's placeholder when it was never named. */
  readonly name: string
  /** Room type as the server reports it. */
  readonly roomType: 'public' | 'private'
  /** Room credential; used for the bind handshake and never reported in a binding view. */
  readonly cookie: string
  /** Access key the invite link carried, when the request did not already supply one. */
  readonly accessKey?: string
}

/** Why resolving a room reference was refused. */
export type ResolveFailureCode =
  | 'invalid-value'
  | 'room-unknown'
  | 'room-private'
  | 'room-unreachable'
  | 'resolution-unsupported'

/** Room-resolution outcome for the binding form. */
export type ResolveResult =
  | { readonly ok: true; readonly room: ResolvedRoom }
  | { readonly ok: false; readonly code: ResolveFailureCode }

/** Remove the bound member from its room while keeping the binding. */
export interface LeaveRequest {
  /** Session whose bound member leaves the room. */
  readonly sessionId: string
}

/** Leave-room outcome; the binding row survives with status `left`. */
export type LeaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'session-unknown' | 'not-bound' | 'room-unreachable' }

/** Re-enter the room of a binding whose member left it. */
export interface RejoinRequest {
  /** Session whose binding re-enters its room. */
  readonly sessionId: string
  /** Fresh access key a private room requires for a member that already left. */
  readonly accessKey?: string
}

/** Why re-entering a room was refused. */
export type RejoinFailureCode =
  | 'session-unknown'
  | 'not-bound'
  | 'not-left'
  | 'room-unreachable'
  | 'room-rejected'

/** Re-enter outcome. */
export type RejoinResult =
  | { readonly ok: true; readonly binding: BindingView }
  | { readonly ok: false; readonly code: RejoinFailureCode }

/** One public chat-bridge room as `list_rooms` reports it; no credential is included. */
export interface RoomSummary {
  /** Stable room id; a room cookie hashes to this value. */
  readonly roomId: string
  /** Room name, or the server's placeholder when it was never named. */
  readonly name: string
  /** Current member count. */
  readonly members: number
  /** Messages retained in the room's active window. */
  readonly messages: number
}

/** Room-discovery outcome for the binding form. */
export type RoomListResult =
  | { readonly ok: true; readonly rooms: readonly RoomSummary[] }
  | { readonly ok: false; readonly code: 'room-unreachable' }

/** One parsed room message ready for delivery. */
export interface BridgeMessage {
  /** Room message id; strictly increasing per room. */
  readonly id: number
  /** Sender name with any embedded permission markers stripped. */
  readonly sender: string
  /** Addressed member when the header names one; absent for broadcasts. */
  readonly target?: string
  /** Server timestamp from the message header. */
  readonly sentAt: string
  /** Message body, with continuation lines joined by newlines. */
  readonly body: string
}

/** Parsed `get_messages` output: deliverable messages and the cursor ceiling. */
export interface ParsedWire {
  readonly messages: readonly BridgeMessage[]
  /** Largest header id seen, including headers whose fields failed to parse. */
  readonly maxSeenId: number
  /** Header ids whose fields failed to parse; logged, never delivered. */
  readonly unparsedIds: readonly number[]
}
