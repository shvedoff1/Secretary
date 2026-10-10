import { getChatConfig } from '../db/repos/chatConfig.repo.js';

/**
 * May an UNADDRESSED message in this chat be scanned for a spend? Only where a
 * Splid group is connected: the scan can end in nothing but a recorded expense,
 * and without a group there is no record_expense tool — the model call would be
 * thrown away (a dota chat paid a full assistant turn for every «купил бкб за
 * 4000», and the 👀 flashed on people's messages while it ran). Elsewhere a
 * spend-looking line is just chatter.
 */
export function expenseScanAllowed(chatId: number): boolean {
  return !!getChatConfig(chatId)?.provider_group_id;
}
