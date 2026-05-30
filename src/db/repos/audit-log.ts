import { db } from "../client.js";
import { auditLog, type AuditLogRow, type NewAuditLogRow } from "../schema.js";

export async function append(row: NewAuditLogRow): Promise<AuditLogRow> {
  const [inserted] = await db.insert(auditLog).values(row).returning();
  if (!inserted) throw new Error("audit append: insert returned no row");
  return inserted;
}
