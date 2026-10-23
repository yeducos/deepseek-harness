/**
 * Chat-bridge binder, browser half: contributes one session-header action that
 * binds the open Session to a room at runtime. Bindings, refusals, and removal
 * all go through the generated Host Remote; this plugin holds no transport
 * state of its own.
 */
import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-experimental-chat-bridge-binder/remote'
import { mountBinding } from './mount.ts'

export { inject } from './mount.ts'
export type { BindingActionInjected, BindingActionProps } from './BindingAction.tsx'
export type { ChatBridgeBinderKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    chatBridgeBinder: import('./locales.ts').ChatBridgeBinderKey
  }
}

/**
 * Mount the runtime binding form and its Remote methods.
 * @param ctx - browser plugin context.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> { return await mountBinding(ctx, remote) }
