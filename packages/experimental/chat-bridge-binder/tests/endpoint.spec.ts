/** Service-address rewrites of user-owned profile patch files. */

import { expect, it } from 'vitest'
import { EndpointRewriteError, rewriteEndpoint } from '../src/endpoint.ts'

const ROWS = ['mcp-chat-bridge', 'chat-bridge-binder'] as const

/** A desktop-style patch with both rows, mixed quoting, an inline comment, and a cookie header. */
const PATCH = [
  '# Desktop profile overrides.',
  '- insert:',
  '    - id: mcp-chat-bridge',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        url: http://127.0.0.1:8200/mcp  # MCP endpoint',
  '        headers:',
  '          Cookie: room=secret',
  '    - id: chat-bridge-binder',
  "      name: '@deepseek-ai/dsh-experimental-chat-bridge-binder'",
  '      config:',
  '        url: "http://127.0.0.1:8200/mcp"',
  '        pollWaitSeconds: 60',
  '',
].join('\n')

it('rewrites both rows and keeps comments, quoting, and adjacent settings', () => {
  const result = rewriteEndpoint(PATCH, 'https://bridge.example.com/mcp', ROWS)
  expect(result.changed).toBe(true)
  expect(result.source).toBe([
    '# Desktop profile overrides.',
    '- insert:',
    '    - id: mcp-chat-bridge',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        url: https://bridge.example.com/mcp  # MCP endpoint',
    '        headers:',
    '          Cookie: room=secret',
    '    - id: chat-bridge-binder',
    "      name: '@deepseek-ai/dsh-experimental-chat-bridge-binder'",
    '      config:',
    '        url: "https://bridge.example.com/mcp"',
    '        pollWaitSeconds: 60',
    '',
  ].join('\n'))
})

it('finds double- and single-quoted row ids', () => {
  const source = PATCH
    .replace('- id: mcp-chat-bridge', '- id: "mcp-chat-bridge"')
    .replace('- id: chat-bridge-binder', "- id: 'chat-bridge-binder'")
  const result = rewriteEndpoint(source, 'https://bridge.example.com/mcp', ROWS)
  expect(result.changed).toBe(true)
  expect(result.source).toContain('url: https://bridge.example.com/mcp  # MCP endpoint')
  expect(result.source).toContain('url: "https://bridge.example.com/mcp"')
})

it('fills a url line that holds only a comment', () => {
  const source = PATCH.replace('url: "http://127.0.0.1:8200/mcp"', 'url:  # unset')
  const result = rewriteEndpoint(source, 'https://bridge.example.com/mcp', ROWS)
  expect(result.source).toContain('        url:  https://bridge.example.com/mcp # unset')
})

it('fills an empty url line without inventing a comment', () => {
  const source = PATCH.replace('url: "http://127.0.0.1:8200/mcp"\n', 'url:\n')
  const result = rewriteEndpoint(source, 'https://bridge.example.com/mcp', ROWS)
  expect(result.source).toContain('        url: https://bridge.example.com/mcp\n        pollWaitSeconds: 60')
})

it('keeps a tab-separated inline comment', () => {
  const source = PATCH.replace(
    'url: http://127.0.0.1:8200/mcp  # MCP endpoint',
    'url:\thttp://127.0.0.1:8200/mcp\t# tab comment',
  )
  const result = rewriteEndpoint(source, 'https://bridge.example.com/mcp', ROWS)
  expect(result.source).toContain('url:\thttps://bridge.example.com/mcp\t# tab comment')
})

it('keeps CRLF terminators and the final newline', () => {
  const source = PATCH.replaceAll('\n', '\r\n')
  const result = rewriteEndpoint(source, 'https://bridge.example.com/mcp', ROWS)
  expect(result.source).not.toMatch(/[^\r]\n/)
  expect(result.source.endsWith('\r\n')).toBe(true)
  expect(result.source).toContain('url: https://bridge.example.com/mcp  # MCP endpoint\r\n')
})

it('leaves a source without a final newline unchanged in its last line', () => {
  const source = PATCH.slice(0, -1)
  const result = rewriteEndpoint(source, 'https://bridge.example.com/mcp', ROWS)
  expect(result.source.endsWith('\n')).toBe(false)
  expect(result.source.endsWith('pollWaitSeconds: 60')).toBe(true)
})

it('keeps the source byte-identical when both rows already hold the address', () => {
  const result = rewriteEndpoint(PATCH, 'http://127.0.0.1:8200/mcp', ROWS)
  expect(result.changed).toBe(false)
  expect(result.source).toBe(PATCH)
})

it('reports a missing row id', () => {
  const source = PATCH.replace('    - id: chat-bridge-binder\n', '    - id: another-plugin\n')
  expect(() => rewriteEndpoint(source, 'https://bridge.example.com/mcp', ROWS)).toThrow(EndpointRewriteError)
  expect(() => rewriteEndpoint(source, 'https://bridge.example.com/mcp', ROWS)).toThrow('"chat-bridge-binder" not found')
})

it('reports a row without a url line', () => {
  const source = PATCH.replace('        url: "http://127.0.0.1:8200/mcp"\n', '')
  expect(() => rewriteEndpoint(source, 'https://bridge.example.com/mcp', ROWS)).toThrow('has no url line')
})

it('reports a row with more than one url line', () => {
  const source = PATCH.replace(
    '        pollWaitSeconds: 60',
    '        pollWaitSeconds: 60\n        url: http://127.0.0.1:8201/mcp',
  )
  expect(() => rewriteEndpoint(source, 'https://bridge.example.com/mcp', ROWS)).toThrow('more than one url line')
})
