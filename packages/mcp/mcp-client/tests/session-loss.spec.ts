/**
 * Tests for the Streamable HTTP session-loss seam: a restarted server answers
 * `Session not found` instead of closing the transport, so the transport must
 * report it for the supervisor to rebuild the connection.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JSONRPCMessage } from '@modelcontextprotocol/client'
import type { Config } from '@deepseek-ai/dsh-mcp-client'
import { createTransport, isSessionLostMessage, watchSessionLoss } from '@deepseek-ai/dsh-mcp-client/src/transport.ts'

const httpConfig: Config = {
  transport: 'streamable-http',
  serverName: 'web',
  url: 'http://127.0.0.1:9/mcp',
  headers: {},
  toolCallTimeoutMs: 5_000,
  failOnStartupError: false,
}

const initialize: JSONRPCMessage = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
}

const initializeResult = {
  jsonrpc: '2.0',
  id: 1,
  result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } },
}

const sessionLost: JSONRPCMessage = {
  jsonrpc: '2.0',
  id: 'server-error',
  error: { code: -32600, message: 'Session not found' },
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** Queue the responses the transport's HTTP requests will receive. */
function stubFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => {
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected HTTP request')
    return next
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Streamable HTTP session loss', () => {
  it.each([404, 410])('reports an HTTP %i for a request carrying an established session', async (status) => {
    stubFetch(
      jsonResponse(initializeResult, 200, { 'mcp-session-id': 'session-1' }),
      jsonResponse({ jsonrpc: '2.0', id: 2, result: { tools: [] } }),
      jsonResponse(sessionLost, status),
    )
    const onSessionLost = vi.fn()
    const transport = createTransport(httpConfig, onSessionLost)
    try {
      await transport.start()
      await transport.send(initialize)
      await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      expect(onSessionLost).not.toHaveBeenCalled()
      await expect(transport.send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })).rejects.toThrow()
      expect(onSessionLost).toHaveBeenCalledTimes(1)
    } finally {
      await transport.close()
    }
  })

  it('does not report a 404 before any session exists', async () => {
    stubFetch(jsonResponse(sessionLost, 404))
    const onSessionLost = vi.fn()
    const transport = createTransport(httpConfig, onSessionLost)
    try {
      await transport.start()
      await expect(transport.send(initialize)).rejects.toThrow()
      expect(onSessionLost).not.toHaveBeenCalled()
    } finally {
      await transport.close()
    }
  })

  it('leaves session reporting to the caller when no observer is configured', async () => {
    stubFetch(
      jsonResponse(initializeResult, 200, { 'mcp-session-id': 'session-1' }),
      jsonResponse(sessionLost, 404),
    )
    const transport = createTransport(httpConfig)
    try {
      await transport.start()
      await transport.send(initialize)
      await expect(transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).rejects.toThrow()
    } finally {
      await transport.close()
    }
  })

  it('reports an HTTP 200 JSON-RPC session error without dropping the client handler', () => {
    const onSessionLost = vi.fn()
    const received: JSONRPCMessage[] = []
    const transport = createTransport(httpConfig, onSessionLost)
    transport.onmessage = (message) => { received.push(message) }
    watchSessionLoss(transport, onSessionLost)

    transport.onmessage?.(sessionLost)
    expect(onSessionLost).toHaveBeenCalledTimes(1)
    expect(received).toEqual([sessionLost])
  })

  it('recognises the session-lost messages servers use', () => {
    for (const message of ['Session not found', 'Session ID was not found', 'Session terminated', 'Session expired']) {
      expect(isSessionLostMessage({ jsonrpc: '2.0', id: 'server-error', error: { code: -32600, message } })).toBe(true)
    }
  })

  it('ignores errors and results that are not session-level', () => {
    const onSessionLost = vi.fn()
    const transport = createTransport(httpConfig, onSessionLost)
    transport.onmessage = () => {}
    watchSessionLoss(transport, onSessionLost)

    transport.onmessage?.({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found' } })
    transport.onmessage?.({ jsonrpc: '2.0', id: 3, result: { tools: [] } })
    expect(onSessionLost).not.toHaveBeenCalled()
    expect(isSessionLostMessage({ jsonrpc: '2.0', id: 3, result: { tools: [] } })).toBe(false)
  })
})
