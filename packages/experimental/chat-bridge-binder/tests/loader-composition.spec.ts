/** Real Loader composition: the binder boots from cordis.yml and wakes a bound Session over a fake room. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ChatBridgeBinderService from '../src/index.ts'
import { startFakeChatBridge, type FakeChatBridge } from './fake-room.ts'
import { agentFor, type HarnessAgent } from './harness.ts'

let root: string | undefined
let context: Context | undefined
let room: FakeChatBridge | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await room?.close()
  room = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Provide the Session, Agent, and durable-storage services the binder injects. */
async function provideHostServices(ctx: Context): Promise<HarnessAgent> {
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Storage)
  const pool = new MemoryMediaPool()
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  const agent = agentFor(ctx, 'loader-session')
  ctx.provide('sessionController', { resolveAgent: async () => ({ agent }) } as never)
  ctx.on('session/flush', () => {})
  ctx.provide('sessionPersistence', {} as never)
  return agent
}

it('loads the Service export from cordis.yml and wakes the declared Session', { timeout: 60_000 }, async () => {
  room = await startFakeChatBridge()
  root = await mkdtemp(join(tmpdir(), 'dsh-chat-bridge-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-experimental-chat-bridge-binder'",
    '  config:',
    `    url: ${room.url}`,
    '    pollWaitSeconds: 1',
    '    bindings:',
    '      - sessionId: loader-session',
    '        cookie: cookie-loader',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  const agent = await provideHostServices(context)
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-experimental-chat-bridge-binder', ChatBridgeBinderService],
  ])
  // The module-import seam is the full Node loader surface; this fixture supplies only
  // the import hook the temp config exercises, so it writes through Reflect.
  Reflect.set(context.loader, 'internal', {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  })
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  expect(context.chatBridgeBinder).toBeInstanceOf(ChatBridgeBinderService)

  room.push('AI-Server-01', 'wake from the room')
  await vi.waitFor(() => { expect(agent.followup).toHaveBeenCalled() })
  const message = agent.followup.mock.calls[0]![0]
  expect(message.source).toEqual({ kind: 'chat-bridge' })
  expect((message.content[0] as { text: string }).text).toContain('wake from the room')
})
