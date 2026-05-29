import { env } from "./env.js";

// Light-weight timezone helpers tied to the configured product timezone.
// We don't pull in moment/dayjs — Intl is enough for our windows.

function partsToZonedISO(parts: Intl.DateTimeFormatPart[], hour: number, minute: number, second: number): string {
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const y = get("year");
  const m = get("month");
  const d = get("day");
  const offset = zoneOffsetString(env.productTimezone, new Date(`${y}-${m}-${d}T12:00:00Z`));
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}${offset}`;
}

function zoneOffsetString(timeZone: string, when: Date): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  });
  const parts = fmt.formatToParts(when);
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-0";
  const match = /GMT([+-]\d{1,2})(?::?(\d{2}))?/.exec(raw);
  if (!match) return "+00:00";
  const hours = parseInt(match[1] ?? "0", 10);
  const mins = parseInt(match[2] ?? "0", 10);
  const sign = hours >= 0 ? "+" : "-";
  return `${sign}${String(Math.abs(hours)).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function todayPartsInZone(now: Date = new Date()): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: env.productTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
}

export function startOfTodayISO(now: Date = new Date()): string {
  return partsToZonedISO(todayPartsInZone(now), 0, 0, 0);
}

export function endOfTodayISO(now: Date = new Date()): string {
  return partsToZonedISO(todayPartsInZone(now), 23, 59, 59);
}

export function addDaysISO(iso: string, days: number): string {
  // iso has zone offset; shift the calendar day component.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-]\d{2}:\d{2})$/.exec(iso);
  if (!m) throw new Error(`Bad ISO: ${iso}`);
  const [, yStr, monStr, dStr, hh, mm, ss, off] = m as unknown as string[];
  const d = new Date(Date.UTC(Number(yStr), Number(monStr) - 1, Number(dStr)));
  d.setUTCDate(d.getUTCDate() + days);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day}T${hh}:${mm}:${ss}${off}`;
}

export function formatEventTimeRange(start?: { dateTime?: string; date?: string }, end?: { dateTime?: string; date?: string }): string {
  if (!start) return "";
  // all-day
  if (start.date && !start.dateTime) {
    return `${start.date} (all day)`;
  }
  const s = start.dateTime ? new Date(start.dateTime) : null;
  const e = end?.dateTime ? new Date(end.dateTime) : null;
  if (!s) return "";
  const fmt: Intl.DateTimeFormatOptions = {
    timeZone: env.productTimezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  const startStr = new Intl.DateTimeFormat("en-US", fmt).format(s);
  if (!e) return startStr;
  const endStr = new Intl.DateTimeFormat("en-US", {
    timeZone: env.productTimezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(e);
  return `${startStr} → ${endStr}`;
}
