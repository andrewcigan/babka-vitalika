import { eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import { systemKv } from "../schema.js";

export async function getText(key: string): Promise<string | null> {
  const [row] = await db.select().from(systemKv).where(eq(systemKv.key, key)).limit(1);
  return row?.valueText ?? null;
}

export async function setText(key: string, value: string): Promise<void> {
  await db
    .insert(systemKv)
    .values({ key, valueText: value })
    .onConflictDoUpdate({
      target: systemKv.key,
      set: { valueText: value, updatedAt: sql`now()` },
    });
}

export async function getJson<T = unknown>(key: string): Promise<T | null> {
  const [row] = await db.select().from(systemKv).where(eq(systemKv.key, key)).limit(1);
  return (row?.valueJson as T | undefined) ?? null;
}

export async function setJson(key: string, value: unknown): Promise<void> {
  await db
    .insert(systemKv)
    .values({ key, valueJson: value })
    .onConflictDoUpdate({
      target: systemKv.key,
      set: { valueJson: value, updatedAt: sql`now()` },
    });
}
