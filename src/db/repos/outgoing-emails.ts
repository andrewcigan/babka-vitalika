import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "../client.js";
import { outgoingEmails, type NewOutgoingEmail, type OutgoingEmail } from "../schema.js";

export async function createPendingConfirm(
  input: Omit<NewOutgoingEmail, "status" | "resolvedAt">,
): Promise<OutgoingEmail> {
  const [row] = await db
    .insert(outgoingEmails)
    .values({ ...input, status: "pending_confirm" })
    .returning();
  if (!row) throw new Error("createPendingConfirm: insert returned no row");
  return row;
}

export async function getById(id: bigint): Promise<OutgoingEmail | null> {
  const [row] = await db.select().from(outgoingEmails).where(eq(outgoingEmails.id, id)).limit(1);
  return row ?? null;
}

export async function markSent(
  id: bigint,
  gmailSentMessageId: string,
  gmailThreadId: string | null,
): Promise<void> {
  await db
    .update(outgoingEmails)
    .set({
      status: "sent",
      gmailSentMessageId,
      gmailThreadId,
      resolvedAt: sql`now()`,
    })
    .where(eq(outgoingEmails.id, id));
}

export async function markCancelled(id: bigint): Promise<void> {
  await db
    .update(outgoingEmails)
    .set({ status: "cancelled", resolvedAt: sql`now()` })
    .where(eq(outgoingEmails.id, id));
}

export async function markFailed(id: bigint, errorText: string): Promise<void> {
  await db
    .update(outgoingEmails)
    .set({
      status: "failed",
      sendErrorText: errorText,
      resolvedAt: sql`now()`,
    })
    .where(eq(outgoingEmails.id, id));
}

export async function listExpiredPending(now: Date = new Date()): Promise<OutgoingEmail[]> {
  return db
    .select()
    .from(outgoingEmails)
    .where(and(eq(outgoingEmails.status, "pending_confirm"), lte(outgoingEmails.expiresAt, now)));
}
