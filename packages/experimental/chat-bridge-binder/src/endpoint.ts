/**
 * Line-oriented rewrites of the chat-bridge service address in a profile patch
 * file. The patch file is user-owned YAML, so the rewrite preserves comments,
 * indentation, quoting, and each line's terminator instead of re-serializing
 * the document.
 */

/** Patch row ids whose `config.url` the service-address editor rewrites by default. */
export const DEFAULT_ENDPOINT_ROWS: readonly string[] = ['mcp-chat-bridge', 'chat-bridge-binder']

/** Rewritten patch source and whether any character changed. */
export interface EndpointRewrite {
  /** Complete next file content, with every untouched line byte-identical. */
  readonly source: string
  /** Whether the rewritten source differs from the input. */
  readonly changed: boolean
}

/** A listed row id, or its unique `url:` line, is absent from the patch source. */
export class EndpointRewriteError extends Error {
  override name = 'EndpointRewriteError'
}

/** One source line without its terminator. */
interface SourceLine {
  readonly text: string
  readonly ending: string
}

/** A block-style entry line carrying its id, with an optional trailing comment. */
const ID_LINE = /^([ \t]*)-[ \t]+id:[ \t]*(?:"([^"]*)"|'([^']*)'|([^ \t#]+))[ \t]*(?:#.*)?$/

/** One `url:` key line; the indentation and the spacing after the colon are kept. */
const URL_LINE = /^([ \t]*)url:([ \t]*)(.*)$/

/**
 * Split source into lines that each keep their own terminator, so joining the
 * parts restores the input exactly, mixed endings included.
 * @param source - complete file content.
 * @returns one entry per line, including a final line without a terminator.
 */
function splitLines(source: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '\n') continue
    const crlf = index > start && source[index - 1] === '\r'
    lines.push({
      text: source.slice(start, crlf ? index - 1 : index),
      ending: crlf ? '\r\n' : '\n',
    })
    start = index + 1
  }
  if (start < source.length) lines.push({ text: source.slice(start), ending: '' })
  return lines
}

/** Index just past the spaces and tabs starting at `start`. */
function skipBlanks(text: string, start: number): number {
  let end = start
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end += 1
  return end
}

/** Leading spaces and tabs of one line. */
function indentOf(text: string): string {
  return text.slice(0, skipBlanks(text, 0))
}

/** The id an entry line declares, or undefined when the line is not an id line. */
function idOf(text: string): string | undefined {
  const match = ID_LINE.exec(text)
  if (match === null) return undefined
  const doubleQuoted = match[2]
  if (doubleQuoted !== undefined) return doubleQuoted
  const singleQuoted = match[3]
  if (singleQuoted !== undefined) return singleQuoted
  return match[4]
}

/**
 * Index where a trailing YAML comment begins in one scalar, or -1 when the
 * whole scalar is a value. `#` counts as a comment marker only outside quotes
 * and after whitespace, so a URL fragment stays part of the value.
 */
function commentStart(scalar: string): number {
  let quote = ''
  for (let index = 0; index < scalar.length; index += 1) {
    const char = scalar[index]
    if (quote !== '') {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || scalar[index - 1] === ' ' || scalar[index - 1] === '\t')) return index
  }
  return -1
}

/**
 * Replace the scalar of one `url:` line with `url`, keeping indentation,
 * spacing, quote style, and any inline comment.
 * @param text - one `url:` line without its terminator.
 * @param url - replacement address.
 * @returns the rewritten line.
 */
function replaceUrlLine(text: string, url: string): string {
  // Callers pass only URL_LINE matches, so the first colon ends the `url` key.
  const keyEnd = text.indexOf(':')
  const indent = text.slice(0, keyEnd - 'url'.length)
  const payloadStart = skipBlanks(text, keyEnd + 1)
  const gap = text.slice(keyEnd + 1, payloadStart)
  const payload = text.slice(payloadStart)
  const commentAt = commentStart(payload)
  const value = commentAt === -1 ? payload : payload.slice(0, commentAt)
  const comment = commentAt === -1 ? '' : payload.slice(commentAt)
  const trimmed = value.trim()
  if (trimmed === '') return `${indent}url:${gap === '' ? ' ' : gap}${url}${comment === '' ? '' : ` ${comment}`}`
  const lead = value.slice(0, value.length - value.trimStart().length)
  const trail = value.slice(value.trimEnd().length)
  const quote = trimmed.charAt(0)
  const core = (quote === '"' || quote === "'") && trimmed.length >= 2 && trimmed.endsWith(quote)
    ? `${quote}${url}${quote}`
    : url
  return `${indent}url:${gap}${lead}${core}${trail}${comment}`
}

/**
 * Rewrite the `config.url` of every listed patch row. A row runs from its
 * `- id:` line to the next non-blank line at the same or a smaller
 * indentation; the single `url:` line inside that block supplies the value.
 * @param source - current patch file content.
 * @param url - new http or https address to place in every row.
 * @param rowIds - row ids whose unique `url:` line is replaced.
 * @returns the rewritten source with each line's original terminator.
 * @throws {EndpointRewriteError} when a row id is missing, or its block has no
 *   `url:` line or more than one.
 */
export function rewriteEndpoint(source: string, url: string, rowIds: readonly string[]): EndpointRewrite {
  const lines = splitLines(source)
  for (const rowId of rowIds) {
    const startLine = lines.find(line => idOf(line.text) === rowId)
    if (startLine === undefined) throw new EndpointRewriteError(`endpoint row "${rowId}" not found`)
    const start = lines.indexOf(startLine)
    const blockIndent = indentOf(startLine.text).length
    let end = start + 1
    for (const line of lines.slice(end)) {
      if (line.text.trim() !== '' && indentOf(line.text).length <= blockIndent) break
      end += 1
    }
    let target: { readonly index: number; readonly line: SourceLine } | undefined
    for (const [offset, line] of lines.slice(start + 1, end).entries()) {
      if (!URL_LINE.test(line.text)) continue
      if (target !== undefined) throw new EndpointRewriteError(`endpoint row "${rowId}" has more than one url line`)
      target = { index: start + 1 + offset, line }
    }
    if (target === undefined) throw new EndpointRewriteError(`endpoint row "${rowId}" has no url line`)
    lines[target.index] = { text: replaceUrlLine(target.line.text, url), ending: target.line.ending }
  }
  const rewritten = lines.map(line => line.text + line.ending).join('')
  return { source: rewritten, changed: rewritten !== source }
}
