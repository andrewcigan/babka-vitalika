export type BotMode = "prod" | "test";

// Per-chat runtime switch between the production n8n gateway (client's Google
// account) and the test gateway (operator's own account). In-memory on purpose:
// a bot restart resets everyone to "prod", which is the safe default.
const modeByChat = new Map<number, BotMode>();

export function getMode(chatId: number | undefined): BotMode {
  if (chatId === undefined) return "prod";
  return modeByChat.get(chatId) ?? "prod";
}

export function setMode(chatId: number, mode: BotMode): void {
  modeByChat.set(chatId, mode);
}
