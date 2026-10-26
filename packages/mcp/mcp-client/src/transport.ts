/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL.
 *
 * A Streamable HTTP server that restarts loses every session it issued, so the
 * next request answers `Session not found` — either as HTTP 404 or as an
 * HTTP 200 JSON-RPC error. The MCP SDK treats neither as a transport close, so
 * the supervisor would keep calling tools against a dead session. Both signals
 * are surfaced here and reported through `onSessionLost`, which lets the
 * supervisor close the generation and run its normal reconnect policy.
 *
 * @module
 */

import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './index.ts'

/** JSON-RPC error text an MCP server uses when it no longer knows this session. */
const SESSION_LOST = /session(?: id)?(?: (?:was|is))? (?:not found|terminated|expired)/i

/** HTTP statuses a Streamable HTTP server uses for a session it no longer knows. */
const SESSION_GONE_STATUSES = new Set([404, 410])

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * Whether a JSON-RPC error reports that the server forgot this transport's
 * session (for example after the server restarted).
 *
 * @param message - Message delivered by an MCP transport.
 * @returns True when the connection must be rebuilt.
 */
export function isSessionLostMessage(message: JSONRPCMessage): boolean {
  if (!('error' in message)) return false
  return SESSION_LOST.test(message.error.message)
}

/**
 * Send the client's own message handler through a session check without
 * changing what the client sees. Reports are advisory: the handler still runs.
 *
 * @param transport - Transport whose `onmessage` the MCP client installed.
 * @param onSessionLost - Called for each session-level error message.
 */
export function watchSessionLoss(transport: Transport, onSessionLost: () => void): void {
  const forward = transport.onmessage
  transport.onmessage = (message, extra) => {
    if (isSessionLostMessage(message)) onSessionLost()
    forward?.(message, extra)
  }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @param onSessionLost - Called when an HTTP session no longer exists; the
 *   Streamable HTTP transport stays open on its own, so the caller must close
 *   it to reach its reconnect path. Stdio has no session to lose.
 * @returns A connected-ready MCP Transport (stdio or Streamable HTTP).
 */
export function createTransport(config: Config, onSessionLost?: () => void): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http': {
      // The SDK throws on non-ok responses without delivering their JSON-RPC
      // body, so a terminated session's 404 can only be observed here. The
      // handshake response is the only one that carries a new session id, so
      // tracking that header is enough to tell a lost session from a server
      // that was never reachable.
      let hasSession = false
      const watchingFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const response = await fetch(input, init)
        if (response.headers.get('mcp-session-id') !== null) {
          hasSession = true
        } else if (hasSession && onSessionLost !== undefined && SESSION_GONE_STATUSES.has(response.status)) {
          onSessionLost()
        }
        return response
      }
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        { requestInit: { headers: config.headers }, fetch: watchingFetch },
      )
    }
  }
}
