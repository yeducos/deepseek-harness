/**
 * Parser for the chat-bridge `get_messages` text wire format.
 *
 * The tool returns plain text: an optional `[新消息]` preamble, one header line
 * per message (`[id] [真人|AI] [已读|未读] sender [→ target] (timestamp): first
 * body line`), continuation body lines, and `[协作状态]`/`[阅读状态]`/`[建议]`/
 * `[轮询结果]` footer lines. Header ids drive the durable cursor, so a header
 * matching the id probe but failing full field parsing still advances the
 * cursor while its content is reported as unparsed. A body continuation line
 * that happens to imitate a header or footer splits the body; the server never
 * emits such lines itself.
 *
 * @module
 */

import type { BridgeMessage, ParsedWire } from './types.ts'

/** Full header grammar for one message. */
const HEADER = /^\[(\d+)\] \[(?:真人|AI)\] (?:(?:已读|未读)\s+)?(.+?)(?: → (.+?))? \((\d{4}-\d{2}-\d{2}T[^)]*)\): (.*)$/

/** Minimal header probe; a match that fails HEADER still counts for the cursor. */
const HEADER_PROBE = /^\[(\d+)\] \[/

/** Known footer lines that terminate a message body. */
const FOOTER = /^\[(?:协作状态|阅读状态|建议|轮询结果)\]/

/** Permission markers the server may embed inside the sender field. */
const SENDER_MARK = /\[(?:权限=[^\]]*|权限拒绝)\]/g

/**
 * Parse one `get_messages` text payload.
 * @param text - Exact text from the tool's first content block.
 * @returns Deliverable messages, the largest seen header id, and unparsed header ids.
 */
export function parseWireText(text: string): ParsedWire {
  const messages: BridgeMessage[] = []
  const unparsedIds: number[] = []
  let maxSeenId = 0
  let current: { id: number; sender: string; target: string | undefined; sentAt: string; body: string[] } | undefined
  const flush = (): void => {
    if (current === undefined) return
    messages.push({
      id: current.id,
      sender: current.sender,
      ...(current.target === undefined ? {} : { target: current.target }),
      sentAt: current.sentAt,
      body: current.body.join('\n').trimEnd(),
    })
    current = undefined
  }
  for (const line of text.split('\n')) {
    const probe = HEADER_PROBE.exec(line)
    if (probe !== null) {
      flush()
      const id = Number(probe[1])
      maxSeenId = Math.max(maxSeenId, id)
      const header = HEADER.exec(line)
      if (header === null) {
        unparsedIds.push(id)
        continue
      }
      // HEADER's sender, timestamp, and body groups are required, so a match always carries them.
      /* v8 ignore next 7 -- the fallbacks satisfy noUncheckedIndexedAccess for groups a match always carries. */
      current = {
        id,
        sender: (header[2] ?? '').replace(SENDER_MARK, '').trim(),
        target: header[3]?.trim(),
        sentAt: header[4] ?? '',
        body: [header[5] ?? ''],
      }
      continue
    }
    if (FOOTER.test(line)) {
      flush()
      continue
    }
    current?.body.push(line)
  }
  flush()
  return { messages, maxSeenId, unparsedIds }
}

/** Marker line appended to a body cut by {@link truncateBody}. */
function truncationMarker(maxBytes: number): string {
  return `\n[message body truncated at ${maxBytes} bytes]`
}

/**
 * Bound one message body to `maxBytes` UTF-8 bytes, cutting at a code-point
 * boundary and appending a visible truncation marker. Bodies within the
 * budget return unchanged.
 * @param body - Raw body from the wire.
 * @param maxBytes - Configured per-message budget.
 * @returns The bounded body, including the marker when truncation happened.
 */
export function truncateBody(body: string, maxBytes: number): string {
  if (Buffer.byteLength(body, 'utf8') <= maxBytes) return body
  const marker = truncationMarker(maxBytes)
  const budget = maxBytes - Buffer.byteLength(marker, 'utf8')
  const bytes = Buffer.from(body, 'utf8')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let end = budget; end > 0; end -= 1) {
    try {
      return `${decoder.decode(bytes.subarray(0, end))}${marker}`
    } catch {
      // The slice ended mid code-point sequence; back off one byte and retry.
    }
  }
  /* v8 ignore next -- maxMessageBytes >= 256 leaves room for at least one code point. */
  return marker
}
