import { desc, eq, lte } from "drizzle-orm";
import { db } from "../client.js";
import {
  pendingEventEdits,
  type NewPendingEventEdit,
  type PendingEventEdit,
} from "../schema.js";

export async function create(input: NewPendingEventEdit): Promise<PendingEventEdit> {
  const [row] = await db.insert(pendingEventEdits).values(input).returning();
  if (!row) throw new Error("pendingEventEdit create: no row");
  return row;
}

export async function findOpenForChat(chatId: bigint): Promise<PendingEventEdit | null> {
  const [row] = await db
    .select()
    .from(pendingEventEdits)
    .where(eq(pendingEventEdits.chatId, chatId))
    .orderBy(desc(pendingEventEdits.createdAt))
    .limit(1);
  return row ?? null;
}

export async function setTarget(id: bigint, targetEventId: string): Promise<void> {
  await db
    .update(pendingEventEdits)
    .set({ targetEventId, state: "awaiting_button" })
    .where(eq(pendingEventEdits.id, id));
}

export async function deleteById(id: bigint): Promise<void> {
  await db.delete(pendingEventEdits).where(eq(pendingEventEdits.id, id));
}

export async function listExpired(now: Date = new Date()): Promise<PendingEventEdit[]> {
  return db.select().from(pendingEventEdits).where(lte(pendingEventEdits.expiresAt, now));
}
