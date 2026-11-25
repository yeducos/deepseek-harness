/** Model-visible framing for one delivered wake batch. */

import type { BridgeMessage } from './types.ts'

/**
 * Render the user-role text a woken Session receives. The framing pins the
 * joined reader name and a JSON array of the delivered messages so the model
 * can attribute senders and addressed targets and continue the room
 * conversation through its own chat-bridge tools; the room cookie never appears.
 * @param reader - Joined room name the messages were addressed to.
 * @param messages - Delivered messages in wire order, bodies already bounded.
 * @returns The complete followup text.
 */
export function renderChatBridgeFraming(reader: string, messages: readonly BridgeMessage[]): string {
  return [
    '[CHAT-BRIDGE MESSAGES]',
    'This is a chat-bridge room message delivered while the Session was idle.',
    `reader: ${reader}`,
    `messages_json: ${JSON.stringify(messages.map(message => ({
      id: message.id,
      sender: message.sender,
      ...(message.target === undefined ? {} : { target: message.target }),
      sentAt: message.sentAt,
      body: message.body,
    })))}`,
  ].join('\n')
}
