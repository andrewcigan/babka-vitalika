// Email actions are irreversible, so the brain only *stages* them. The actual
// send happens in the bot's button-callback handler, never autonomously.
export type PendingEmail =
  | { kind: "send"; to: string; subject: string; body: string }
  | { kind: "reply"; threadId: string; body: string }
  | { kind: "trash"; messageId: string; summary: string };

const pending = new Map<number, PendingEmail>();

export function setPending(chatId: number, action: PendingEmail): void {
  pending.set(chatId, action);
}

export function takePending(chatId: number): PendingEmail | undefined {
  const action = pending.get(chatId);
  pending.delete(chatId);
  return action;
}
