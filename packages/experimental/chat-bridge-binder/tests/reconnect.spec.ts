/** Reconnect policy resolution: defaults, tolerated partial config, and loud rejection of invalid bounds. */

import { expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { RECONNECT_DEFAULTS, resolveReconnectPolicy } from '../src/reconnect.ts'

const path = 'binder.reconnect'

it('resolves every default when the deployment states no policy', () => {
  const policy = resolveReconnectPolicy(undefined, path)
  expect(policy).toEqual(RECONNECT_DEFAULTS)
  expect(Object.isFrozen(policy)).toBe(true)
})

it('keeps stated options and fills the rest from the defaults', () => {
  expect(resolveReconnectPolicy({ enabled: false, maxAttempts: 3 }, path)).toEqual({
    ...RECONNECT_DEFAULTS, enabled: false, maxAttempts: 3,
  })
})

it('rejects an unknown option instead of silently ignoring it', () => {
  expect(() => resolveReconnectPolicy({ retries: 2 } as never, path))
    .toThrow('retries is not a reconnect option')
})

it('rejects delays outside the timer range', () => {
  expect(() => resolveReconnectPolicy({ initialDelayMs: 0 }, path))
    .toThrow(`initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  expect(() => resolveReconnectPolicy({ initialDelayMs: Number.POSITIVE_INFINITY }, path))
    .toThrow('initialDelayMs must be a positive finite number')
  expect(() => resolveReconnectPolicy({ initialDelayMs: MAX_TIMER_DELAY_MS + 1 }, path))
    .toThrow('initialDelayMs must be a positive finite number')
  expect(() => resolveReconnectPolicy({ maxDelayMs: 0 }, path))
    .toThrow(`maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  expect(() => resolveReconnectPolicy({ maxDelayMs: Number.NaN }, path))
    .toThrow('maxDelayMs must be a positive finite number')
  expect(() => resolveReconnectPolicy({ maxDelayMs: MAX_TIMER_DELAY_MS + 1 }, path))
    .toThrow('maxDelayMs must be a positive finite number')
})

it('rejects a first delay beyond the ceiling and a non-integer attempt budget', () => {
  expect(() => resolveReconnectPolicy({ initialDelayMs: 900, maxDelayMs: 800 }, path))
    .toThrow('initialDelayMs must be less than or equal to maxDelayMs')
  expect(() => resolveReconnectPolicy({ maxAttempts: 0 }, path))
    .toThrow('maxAttempts must be a positive integer')
  expect(() => resolveReconnectPolicy({ maxAttempts: 1.5 }, path))
    .toThrow('maxAttempts must be a positive integer')
})
