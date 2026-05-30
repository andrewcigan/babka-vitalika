import { and, desc, eq, lte } from "drizzle-orm";
import { db } from "../client.js";
import {
  pendingConflictDecisions,
  type NewPendingConflictDecision,
  type PendingConflictDecision,
} from "../schema.js";

export async function create(
  input: NewPendingConflictDecision,
): Promise<PendingConflictDecision> {
  const [row] = await db.insert(pendingConflictDecisions).values(input).returning();
  if (!row) throw new Error("pendingConflict create: no row");
  return row;
}

export async function findOpenForChat(
  chatId: bigint,
): Promise<PendingConflictDecision | null> {
  const [row] = await db
    .select()
    .from(pendingConflictDecisions)
    .where(eq(pendingConflictDecisions.chatId, chatId))
    .orderBy(desc(pendingConflictDecisions.createdAt))
    .limit(1);
  return row ?? null;
}

export async function deleteById(id: bigint): Promise<void> {
  await db.delete(pendingConflictDecisions).where(eq(pendingConflictDecisions.id, id));
}

export async function advanceState(
  id: bigint,
  state: PendingConflictDecision["state"],
): Promise<void> {
  await db
    .update(pendingConflictDecisions)
    .set({ state })
    .where(eq(pendingConflictDecisions.id, id));
}

export async function listExpired(now: Date = new Date()): Promise<PendingConflictDecision[]> {
  return db
    .select()
    .from(pendingConflictDecisions)
    .where(lte(pendingConflictDecisions.expiresAt, now));
}

void and;
