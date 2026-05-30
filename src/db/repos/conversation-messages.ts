import { and, desc, eq } from "drizzle-orm";
import { db } from "../client.js";
import {
  conversationMessages,
  type ConversationMessage,
  type NewConversationMessage,
} from "../schema.js";

export async function addMessage(input: NewConversationMessage): Promise<ConversationMessage> {
  const [row] = await db.insert(conversationMessages).values(input).returning();
  if (!row) throw new Error("addMessage: insert returned no row");
  return row;
}

export async function listRecentForChat(
  chatId: bigint,
  limit = 50,
): Promise<ConversationMessage[]> {
  const rows = await db
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.chatId, chatId),
        eq(conversationMessages.isArchived, false),
      ),
    )
    .orderBy(desc(conversationMessages.createdAt))
    .limit(limit);
  return rows.reverse();
}
