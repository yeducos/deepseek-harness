/**
 * Reconnect policy resolution mirroring the `dsh-mcp-client` connection
 * supervisor semantics: one attempt budget per outage, exponential delays,
 * and a give-up state that only a plugin reload leaves. The binder needs the
 * policy without the tool-sync machinery that owns it there.
 *
 * @module
 */

import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { ReconnectConfig } from './types.ts'

/** Defaults shared by the Config schema and {@link resolveReconnectPolicy}. */
export const RECONNECT_DEFAULTS: Required<ReconnectConfig> = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})

/* jscpd:ignore-start */
// The policy resolution mirrors dsh-mcp-client's connection supervisor — same
// defaults, bounds, and give-up semantics — without its tool-sync machinery.
// The packages sit on independent dependency planes, so the helper cannot be
// extracted; keep this copy aligned with the original instead.
/** Fully resolved reconnect policy captured at plugin load. */
export type ResolvedReconnectPolicy = Readonly<Required<ReconnectConfig>>

/**
 * The one explicit resolve step from raw reconnect config to the policy the
 * poll loops run. Programmatic construction may bypass Schemastery
 * normalization, so every default and bound is re-judged here —
 * misconfiguration fails the plugin instance at load.
 *
 * @param config - Raw `reconnect` config; omission uses the defaults.
 * @param path - Diagnostic prefix naming the config location in thrown messages.
 * @returns The frozen resolved policy.
 */
export function resolveReconnectPolicy(config: ReconnectConfig | undefined, path: string): ResolvedReconnectPolicy {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(RECONNECT_DEFAULTS, key)) throw new Error(`${path}.${key} is not a reconnect option`)
    }
  }
  const enabled = config?.enabled ?? RECONNECT_DEFAULTS.enabled
  const initialDelayMs = config?.initialDelayMs ?? RECONNECT_DEFAULTS.initialDelayMs
  const maxDelayMs = config?.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs
  const maxAttempts = config?.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (initialDelayMs > maxDelayMs) {
    throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`)
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`${path}.maxAttempts must be a positive integer`)
  }
  return Object.freeze({ enabled, initialDelayMs, maxDelayMs, maxAttempts })
}
/* jscpd:ignore-end */
