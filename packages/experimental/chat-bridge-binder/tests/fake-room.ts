/** In-process fake chat-bridge MCP server for binder tests: real wire format, controllable room state. */

import { z } from 'zod'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'

/** One room message the fake keeps until the binder's cursor consumes it. */
export interface FakeMessage {
  readonly id: number
  readonly sender: string
  readonly target: string | undefined
  readonly sentAt: string
  readonly body: string
}

/** State of the single fake room the binder talks to. */
export interface FakeRoomState {
  /** Messages ever pushed, ids strictly increasing from 1. */
  readonly messages: FakeMessage[]
  /** Names that have been applied under any cookie. */
  readonly names: Set<string>
  /** Name joined per room cookie, for assertions. */
  readonly joined: Map<string, string>
  /** Names whose leave_room call reached the fake, in order. */
  readonly leftNames: string[]
  /** Number of apply_agent_name calls so far. */
  applies: number
  /** Counter feeding the next applied name. */
  nextName: number
}

/** Fault injection knobs; each consumption is one occurrence. */
export interface FakeFaults {
  /** Next N POST requests fail with a plain 500. */
  rejectRequests: number
  /** Next N POST requests return 404 so the SDK treats the session as gone. */
  terminateSessions: number
  /** Next N join_room calls return an isError result. */
  failJoins: number
  /** Next N join_room calls answer with an empty content block instead of text. */
  textlessJoins: number
  /** Error text for the next N get_messages calls, returned as an isError result. */
  toolErrorText: string | undefined
  /** When set, get_messages returns this text verbatim instead of the room render. */
  getMessagesText: (() => string) | undefined
  /** When set, the next apply_agent_name call returns this text verbatim. */
  applyResponseText: string | undefined
}

/** Running fake server and the observations a test asserts against. */
export interface FakeChatBridge {
  url: string
  state: FakeRoomState
  faults: FakeFaults
  /** Room cookie observed per POST, in order. */
  cookies: Array<string | undefined>
  /** Number of POST requests received, including faulted ones. */
  requests: number
  /** Push one message and wake pending long polls. */
  push(sender: string, body: string, target?: string): number
  close(): Promise<void>
}

/** Rooms the fake resolver answers for; the private one requires an access key. */
const PUBLIC_ROOM = { roomId: 'faddba2498de6001', cookie: 'fixture-cookie' } as const
const PRIVATE_ROOM = { roomId: 'deadbeefdeadbeef', cookie: 'fixture-private', accessKey: 'vk-test' } as const

/** Deterministic timestamp for pushed messages, keyed by id. */
function sentAtFor(id: number): string {
  return `2026-01-01T00:00:${String(id % 60).padStart(2, '0')}.000+00:00`
}

/** Text result helper. */
function text(content: string): CallToolResult {
  return { content: [{ type: 'text', text: content }] }
}

/** Error result helper matching chat-bridge's isError convention. */
function toolError(content: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: content }] }
}

/**
 * Render the get_messages wire text exactly as the real server does: preamble,
 * one header per visible message with continuation lines, then footers.
 * Unread state never auto-advances; only ids above `since` are visible.
 */
function render(state: FakeRoomState, since: number, reader: string | undefined, waitSeconds: number): string {
  const visible = state.messages.filter(message =>
    message.id > since && (message.target === undefined || message.target === reader))
  if (visible.length === 0) {
    return waitSeconds === 0 ? '[轮询结果] 无新消息，请继续轮询' : `(等待 ${waitSeconds} 秒无新消息，请继续轮询)`
  }
  const lines = ['[新消息]']
  for (const message of visible) {
    const target = message.target === undefined ? '' : ` → ${message.target}`
    lines.push(`[${message.id}] [AI] 未读 ${message.sender}${target} (${message.sentAt}): ${message.body}`)
  }
  lines.push(`[协作状态] 房间成员: ${state.names.size} 人, 在线: 1 人`)
  lines.push(`[阅读状态] reader=${reader ?? ''} read_through=${since} max_message_id=${state.messages.length} unread=${visible.length} unread_human=0 attention_required=False`)
  lines.push('[建议] 轮到你了，直接回复即可。')
  return lines.join('\n')
}

/** Extract the room cookie from a request Cookie header. */
function parseCookie(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  return /(?:^|;\s*)room=([^;]+)/.exec(header)?.[1]
}

/**
 * Start a fake chat-bridge MCP endpoint. The room renders the real wire
 * format, get_messages long-polls (capped at two seconds) until a push or the
 * wait expires, and unread messages are never consumed server-side.
 */
export async function startFakeChatBridge(options: { preApplied?: readonly string[] } = {}): Promise<FakeChatBridge> {
  const state: FakeRoomState = {
    messages: [], names: new Set(options.preApplied ?? []), joined: new Map(), leftNames: [],
    applies: 0, nextName: 1,
  }
  const faults: FakeFaults = {
    rejectRequests: 0, terminateSessions: 0, failJoins: 0, textlessJoins: 0,
    toolErrorText: undefined, getMessagesText: undefined, applyResponseText: undefined,
  }
  const cookies: Array<string | undefined> = []
  let requests = 0
  const waiters: Array<() => void> = []
  let currentCookie: string | undefined

  const handler = createMcpHandler(() => {
    const mcp = new McpServer(
      { name: 'chat-bridge-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    mcp.registerTool('apply_agent_name', {
      description: 'Applies for a room name.',
      inputSchema: z.object({ role: z.string().optional() }),
    }, async (): Promise<CallToolResult> => {
      if (faults.applyResponseText !== undefined) {
        const content = faults.applyResponseText
        faults.applyResponseText = undefined
        return text(content)
      }
      state.applies += 1
      const name = `AI-Worker-${String(state.nextName++).padStart(2, '0')}`
      state.names.add(name)
      return text(JSON.stringify({ name }))
    })
    mcp.registerTool('join_room', {
      description: 'Joins the room under a name.',
      inputSchema: z.object({ name: z.string(), access_key: z.string().optional() }),
    }, async ({ name }): Promise<CallToolResult> => {
      if (faults.textlessJoins > 0) {
        faults.textlessJoins -= 1
        return { content: [] }
      }
      if (faults.failJoins > 0) {
        faults.failJoins -= 1
        return toolError(`名字 ${name} 未申请`)
      }
      if (!state.names.has(name)) return toolError(`名字 ${name} 未申请`)
      if (currentCookie !== undefined) state.joined.set(currentCookie, name)
      return text('已加入房间，当前发言权: free')
    })
    mcp.registerTool('leave_room', {
      description: 'Leaves the room under a name.',
      inputSchema: z.object({ name: z.string().optional() }),
    }, async ({ name }): Promise<CallToolResult> => {
      if (name === undefined) return toolError('leave_room requires a name')
      state.leftNames.push(name)
      return text(`成员 ${name} 已离开房间`)
    })
    mcp.registerTool('resolve_room', {
      description: 'Resolves an invite link, room id, or cookie into a room cookie.',
      inputSchema: z.object({ value: z.string(), access_key: z.string().optional() }),
    }, async ({ value, access_key: providedKey }): Promise<CallToolResult> => {
      const trimmed = value.trim()
      const urlKey = /[?&](?:key|access_key)=([^&]+)/.exec(trimmed)?.[1]
      const urlCookie = /[?&]cookie=([^&]+)/.exec(trimmed)?.[1]
      const isPublic = trimmed === PUBLIC_ROOM.cookie || trimmed === PUBLIC_ROOM.roomId
        || PUBLIC_ROOM.roomId.startsWith(trimmed) || urlCookie === PUBLIC_ROOM.cookie
      const isPrivate = trimmed === PRIVATE_ROOM.roomId || urlCookie === PRIVATE_ROOM.cookie
      if (!isPublic && !isPrivate) return text('[错误] room-missing: 房间不存在')
      if (isPrivate) {
        const key = providedKey ?? urlKey
        if (key === undefined) return text('[错误] room-private: 私密房间需要访问密钥')
        if (key !== PRIVATE_ROOM.accessKey) return text('[错误] access-key-invalid: 无效的访问密钥')
        return text(JSON.stringify({
          room_id: PRIVATE_ROOM.roomId, room_name: 'binder-private', room_type: 'private',
          cookie: PRIVATE_ROOM.cookie, ...(urlKey === undefined ? {} : { access_key: urlKey }),
        }))
      }
      return text(JSON.stringify({
        room_id: PUBLIC_ROOM.roomId, room_name: 'binder-fixture', room_type: 'public', cookie: PUBLIC_ROOM.cookie,
      }))
    })
    mcp.registerTool('list_rooms', {
      description: 'Lists the public rooms.',
      inputSchema: z.object({}),
    }, async (): Promise<CallToolResult> => text([
      '公共房间列表：',
      `  room_id=faddba2498de6001 name=binder-fixture members=${state.names.size} messages=${state.messages.length}`,
    ].join('\n')))
    mcp.registerTool('get_messages', {
      description: 'Long-polls room messages.',
      inputSchema: z.object({
        cookie: z.string().optional(),
        since: z.number().optional(),
        wait_seconds: z.number().optional(),
        for_member: z.string().optional(),
        reader: z.string().optional(),
        include_read: z.boolean().optional(),
        include_own: z.boolean().optional(),
        wait_for_turn: z.boolean().optional(),
      }),
    }, async ({ since, reader, wait_seconds }): Promise<CallToolResult> => {
      if (faults.toolErrorText !== undefined) {
        const content = faults.toolErrorText
        faults.toolErrorText = undefined
        return toolError(content)
      }
      if (faults.getMessagesText !== undefined) return text(faults.getMessagesText())
      const cursor = since ?? 0
      const wait = Math.min(wait_seconds ?? 0, 2)
      let rendered = render(state, cursor, reader, wait)
      if (!rendered.startsWith('[新消息]') && wait > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { finish() }, wait * 1000)
          const finish = (): void => {
            clearTimeout(timer)
            resolve()
          }
          waiters.push(finish)
        })
        rendered = render(state, cursor, reader, wait)
      }
      return text(rendered)
    })
    return mcp
  })

  const handle = toNodeHandler(handler)
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    requests += 1
    response.on('error', () => {})
    if (faults.rejectRequests > 0) {
      faults.rejectRequests -= 1
      response.writeHead(500).end('fixture fault')
      return
    }
    if (faults.terminateSessions > 0) {
      faults.terminateSessions -= 1
      response.writeHead(404).end('session terminated')
      return
    }
    currentCookie = parseCookie(request.headers.cookie)
    cookies.push(currentCookie)
    await handle(request as NodeIncomingMessageLike, response)
  }
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      response.writeHead(500).end(String(error))
    })
  })
  const listening = Promise.withResolvers<undefined>()
  server.listen(0, '127.0.0.1', () => { listening.resolve(undefined) })
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake chat-bridge has no TCP address')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    state, faults, cookies,
    get requests() { return requests },
    push(sender: string, body: string, target?: string): number {
      const id = state.messages.length + 1
      state.messages.push({ id, sender, target, sentAt: sentAtFor(id), body })
      for (const wake of waiters.splice(0)) wake()
      return id
    },
    close: async () => {
      await handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}
