/**
 * Per-binding MCP Streamable HTTP connection. One MCP SDK `Client` binds one
 * transport for life, so recovery means discarding the whole connection
 * object; this wrapper owns that lifecycle plus the credential header. The
 * room cookie travels only in transport request headers — never in tool
 * arguments, logs, errors, or model-visible content.
 *
 * @module
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { CallToolResult, TextContent } from '@modelcontextprotocol/client'

/** Failure of one tool call reported as an `isError` result by the server. */
export class BridgeToolError extends Error {
  /**
   * @param tool - Tool name the server rejected.
   * @param text - Server-provided error text; the cookie is never part of it.
   */
  constructor(tool: string, text: string) {
    super(`${tool} failed: ${text}`)
    this.name = 'BridgeToolError'
  }
}

/** First text content block of a tool result, when present. */
function resultText(result: CallToolResult): string {
  const block = result.content.find((item): item is TextContent => item.type === 'text')
  if (block === undefined) throw new Error('tool result carried no text content')
  return block.text
}

/** Live connection to one chat-bridge room under one room cookie. */
export class BridgeConnection {
  private client: Client | undefined

  /**
   * @param url - chat-bridge MCP Streamable HTTP endpoint.
   * @param cookie - Room credential for the `Cookie: room=` header.
   */
  constructor(
    private readonly url: string,
    private readonly cookie: string,
  ) {}

  /** Whether a negotiated client exists. */
  get connected(): boolean {
    return this.client !== undefined
  }

  /**
   * Connect a fresh MCP client generation. Server-initiated closure clears
   * the generation so the next poll reconnects.
   */
  async connect(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { Cookie: `room=${this.cookie}` } },
    })
    const client = new Client(
      { name: 'dsh-chat-bridge-binder', version: '0.0.1' },
      { capabilities: {}, versionNegotiation: { mode: 'auto' } },
    )
    client.onclose = () => {
      // A newer generation may already own the field; only this generation clears it.
      /* v8 ignore next -- the SDK reports closure of the generation it owns, which is always the current one. */
      if (this.client === client) this.client = undefined
    }
    await client.connect(transport)
    this.client = client
  }

  /** Drop the current generation; a broken transport's close must not hold the loop. */
  invalidate(): void {
    const client = this.client
    this.client = undefined
    /* v8 ignore next -- a rejected terminate request has no recovery path; the generation is discarded. */
    if (client !== undefined) void client.close().catch(() => undefined)
  }

  /**
   * Graceful close during disposal. A failing terminate request does not block
   * teardown, because the generation is discarded either way.
   */
  async close(): Promise<void> {
    const client = this.client
    this.client = undefined
    /* v8 ignore next -- a rejected terminate request has no recovery path; the generation is discarded. */
    if (client !== undefined) await client.close().catch(() => undefined)
  }

  /**
   * Call one tool and return its first text content block.
   * @param name - Tool name on the chat-bridge server.
   * @param args - Tool arguments; the room cookie must never appear here.
   * @param timeoutMs - Call timeout covering the long-poll wait.
   * @param signal - Shutdown signal aborting an in-flight long poll.
   * @returns The server's text payload.
   */
  async call(name: string, args: Record<string, unknown>, timeoutMs: number, signal: AbortSignal): Promise<string> {
    const client = this.client
    if (client === undefined) throw new Error('chat-bridge-binder: connection is not established')
    const result = await client.callTool({ name, arguments: args }, { signal, timeout: timeoutMs })
    if (result.isError === true) throw new BridgeToolError(name, resultText(result))
    return resultText(result)
  }
}
