import { createHash } from "node:crypto";
import { and, eq, gte, lte, or, sql } from "drizzle-orm";
import { db } from "../client.js";
import { calendarEvents, type CalendarEvent, type NewCalendarEvent } from "../schema.js";

export function buildDedupKey(chatId: bigint, telegramMessageId: bigint, eventSeq: number): string {
  return `${chatId}:${telegramMessageId}:${eventSeq}`;
}

export function buildEventId(dedupKey: string): string {
  const hash = createHash("sha256").update(dedupKey).digest("hex").slice(0, 12);
  return `ce-${hash}`;
}

export async function createPending(
  input: Omit<NewCalendarEvent, "id" | "status"> & { dedupKey: string },
): Promise<CalendarEvent> {
  const id = buildEventId(input.dedupKey);
  const [row] = await db
    .insert(calendarEvents)
    .values({ ...input, id, status: "pending" })
    .returning();
  if (!row) throw new Error("createPending: insert returned no row");
  return row;
}

export async function markActive(
  id: string,
  gcalEventId: string,
  gcalEtag: string | null,
  rawResponseJson?: unknown,
): Promise<void> {
  await db
    .update(calendarEvents)
    .set({
      status: "active",
      gcalEventId,
      gcalEtag,
      rawGcalResponseJson: rawResponseJson ?? null,
      syncedAt: sql`now()`,
    })
    .where(eq(calendarEvents.id, id));
}

export async function cancel(id: string): Promise<void> {
  await db.update(calendarEvents).set({ status: "cancelled" }).where(eq(calendarEvents.id, id));
}

export async function getByDedupKey(dedupKey: string): Promise<CalendarEvent | null> {
  const [row] = await db
    .select()
    .from(calendarEvents)
    .where(eq(calendarEvents.dedupKey, dedupKey))
    .limit(1);
  return row ?? null;
}

export async function listActiveInWindow(
  chatId: bigint,
  fromAt: Date,
  toAt: Date,
): Promise<CalendarEvent[]> {
  return db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.sourceChatId, chatId),
        eq(calendarEvents.status, "active"),
        or(
          and(
            eq(calendarEvents.allDay, false),
            gte(calendarEvents.startAt, fromAt),
            lte(calendarEvents.startAt, toAt),
          ),
          and(
            eq(calendarEvents.allDay, true),
            gte(calendarEvents.startDate, fromAt.toISOString().slice(0, 10)),
            lte(calendarEvents.startDate, toAt.toISOString().slice(0, 10)),
          ),
        ),
      ),
    );
}

export async function listOrphanPending(olderThanMs: number): Promise<CalendarEvent[]> {
  const cutoff = new Date(Date.now() - olderThanMs);
  return db
    .select()
    .from(calendarEvents)
    .where(and(eq(calendarEvents.status, "pending"), lte(calendarEvents.createdAt, cutoff)));
}
