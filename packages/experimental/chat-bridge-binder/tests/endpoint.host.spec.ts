/** Persisting the chat-bridge service address into a profile patch file. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { harness } from './harness.ts'

/** Lets one test make the atomic replacement fail without touching filesystem permissions. */
const writeFails = vi.hoisted(() => ({ value: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>): Promise<void> => {
      if (writeFails.value) throw new Error('simulated write failure')
      await actual.writeFile(...args)
    },
  }
})

const roots: string[] = []

const URL = 'http://127.0.0.1:8200/mcp'

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
  '        url: http://127.0.0.1:8200/mcp',
  '        pollWaitSeconds: 60',
  '',
].join('\n')

/** Write a patch file in a test-owned directory and describe its profile facts. */
async function tempProfile(source: string): Promise<ProfileContext> {
  const root = await mkdtemp(join(tmpdir(), 'chat-bridge-endpoint-'))
  roots.push(root)
  const patchPath = join(root, 'cordis.patch.yml')
  await writeFile(patchPath, source)
  return {
    name: 'desktop',
    dir: root,
    patchPath,
    installAnchor: root,
    cwd: root,
    home: dirname(patchPath),
    startedBundles: [],
    overlays: [],
    telemetryDisabledEnv: undefined,
  }
}

beforeEach(() => { writeFails.value = false })

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('reports the loaded service address', async () => {
  const { service } = await harness({ config: { url: URL } })
  await expect(service.endpoint()).resolves.toEqual({ url: URL })
})

it('rewrites both rows, reports restartRequired, and keeps the running address', async () => {
  const profile = await tempProfile(PATCH)
  const { service } = await harness({ config: { url: URL }, onContext: ctx => ctx.provide('profileContext', profile) })
  await expect(service.setEndpoint({ url: ' https://bridge.example.com/mcp ' })).resolves.toEqual({
    ok: true, url: 'https://bridge.example.com/mcp', restartRequired: true,
  })
  expect(await readFile(profile.patchPath, 'utf8')).toBe(PATCH
    .replace('url: http://127.0.0.1:8200/mcp  # MCP endpoint', 'url: https://bridge.example.com/mcp  # MCP endpoint')
    .replace('        url: http://127.0.0.1:8200/mcp\n        pollWaitSeconds', '        url: https://bridge.example.com/mcp\n        pollWaitSeconds'))
  await expect(service.endpoint()).resolves.toEqual({ url: URL })
})

it('accepts an unchanged address without touching the file', async () => {
  const profile = await tempProfile(PATCH)
  const { service } = await harness({ config: { url: URL }, onContext: ctx => ctx.provide('profileContext', profile) })
  const before = await readFile(profile.patchPath, 'utf8')
  await expect(service.setEndpoint({ url: URL })).resolves.toEqual({ ok: true, url: URL, restartRequired: true })
  expect(await readFile(profile.patchPath, 'utf8')).toBe(before)
})

it('rejects non-http addresses and leaves the file alone', async () => {
  const profile = await tempProfile(PATCH)
  const { service } = await harness({ config: { url: URL }, onContext: ctx => ctx.provide('profileContext', profile) })
  await expect(service.setEndpoint({ url: 'ftp://bridge.example.com/mcp' })).resolves.toEqual({ ok: false, code: 'invalid-url' })
  await expect(service.setEndpoint({ url: 'not a url' })).resolves.toEqual({ ok: false, code: 'invalid-url' })
  expect(await readFile(profile.patchPath, 'utf8')).toBe(PATCH)
})

it('refuses when the launch has no profile context', async () => {
  const { service } = await harness({ config: { url: URL } })
  await expect(service.setEndpoint({ url: 'https://bridge.example.com/mcp' })).resolves.toEqual({
    ok: false, code: 'profile-unavailable',
  })
})

it('refuses when the patch file cannot be read', async () => {
  const profile = await tempProfile(PATCH)
  await rm(profile.patchPath)
  const { service } = await harness({ config: { url: URL }, onContext: ctx => ctx.provide('profileContext', profile) })
  await expect(service.setEndpoint({ url: 'https://bridge.example.com/mcp' })).resolves.toEqual({
    ok: false, code: 'profile-unavailable',
  })
})

it('refuses when a configured row is absent', async () => {
  const profile = await tempProfile(PATCH.replace('    - id: chat-bridge-binder\n', ''))
  const { service } = await harness({ config: { url: URL }, onContext: ctx => ctx.provide('profileContext', profile) })
  await expect(service.setEndpoint({ url: 'https://bridge.example.com/mcp' })).resolves.toEqual({
    ok: false, code: 'row-missing',
  })
})

it('reports a failed write', async () => {
  const profile = await tempProfile(PATCH)
  const { service } = await harness({ config: { url: URL }, onContext: ctx => ctx.provide('profileContext', profile) })
  writeFails.value = true
  await expect(service.setEndpoint({ url: 'https://bridge.example.com/mcp' })).resolves.toEqual({
    ok: false, code: 'write-failed',
  })
  expect(await readFile(profile.patchPath, 'utf8')).toBe(PATCH)
})

it('rejects endpoint row lists that are empty or contain a blank id', async () => {
  await expect(harness({ direct: true, config: { url: URL, endpointRows: [] } })).rejects.toThrow('endpointRows')
  await expect(harness({ direct: true, config: { url: URL, endpointRows: [''] } })).rejects.toThrow('endpointRows')
})
