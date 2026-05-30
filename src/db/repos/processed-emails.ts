import { eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import { processedEmails, type NewProcessedEmail, type ProcessedEmail } from "../schema.js";

export async function exists(gmailMessageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: processedEmails.gmailMessageId })
    .from(processedEmails)
    .where(eq(processedEmails.gmailMessageId, gmailMessageId))
    .limit(1);
  return !!row;
}

export async function insertPendingNotification(
  input: Omit<NewProcessedEmail, "notificationStatus" | "notifiedAt">,
): Promise<ProcessedEmail> {
  const [row] = await db
    .insert(processedEmails)
    .values({ ...input, notificationStatus: "pending" })
    .returning();
  if (!row) throw new Error("insertPendingNotification: insert returned no row");
  return row;
}

export async function markSent(
  gmailMessageId: string,
  telegramMessageId: bigint,
): Promise<void> {
  await db
    .update(processedEmails)
    .set({
      notificationStatus: "sent",
      notificationTelegramMessageId: telegramMessageId,
      notifiedAt: sql`now()`,
    })
    .where(eq(processedEmails.gmailMessageId, gmailMessageId));
}

export async function markFailed(gmailMessageId: string, errorText: string): Promise<void> {
  await db
    .update(processedEmails)
    .set({ notificationStatus: "failed", notificationError: errorText })
    .where(eq(processedEmails.gmailMessageId, gmailMessageId));
}
