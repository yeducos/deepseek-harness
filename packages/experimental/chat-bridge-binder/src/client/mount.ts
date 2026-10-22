/** Runtime binding panel and generated Remote contribution lifecycle. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-experimental-chat-bridge-binder/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { BindingAction, type BindingActionInjected } from './BindingAction.tsx'
import { en, NS, zh } from './locales.ts'

/** Services required to mount the Remote contribution and its header action. */
export const inject = ['remote', 'slots', 'locale']

/**
 * Mount the chat-bridge binding form and withdraw it before its Remote definitions.
 * @param ctx - Client plugin lifetime.
 * @param contribution - generated binder Remote definitions.
 * @returns disposer that removes both contributions.
 */
export async function mountBinding(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.chatBridgeBinder', ...inject.slice(1)], (child) => {
    child.effect(() => child.locale.register(NS, { en, zh }))
    const injected = (): BindingActionInjected => ({
      list: async () => {
        const result = await child.remote.chatBridgeBinder.list()
        if (!result.ok) throw result.error
        return result.value
      },
      rooms: async () => {
        const result = await child.remote.chatBridgeBinder.rooms()
        if (!result.ok) throw result.error
        return result.value
      },
      bind: async (request) => {
        const result = await child.remote.chatBridgeBinder.bind(request)
        if (!result.ok) throw result.error
        return result.value
      },
      unbind: async (sessionId) => {
        const result = await child.remote.chatBridgeBinder.unbind({ sessionId })
        if (!result.ok) throw result.error
        return result.value
      },
    })
    child.slots.inject('conversation.session.header.actions', () => child.slots.register({
      name: 'conversation.session.header.actions',
      id: 'chat-bridge-binding',
      // Follows the background-job list in the header actions band.
      order: 30,
      locale: NS,
      inject: injected,
    }, BindingAction))
  })
  try { await ui } catch (error) { await ui.dispose(); await unmountRemote(); throw error }
  return async () => { await ui.dispose(); await unmountRemote() }
}
