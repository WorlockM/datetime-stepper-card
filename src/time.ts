/**
 * Time helpers.
 *
 * Internally the card works with "wall time": the number of milliseconds of
 * Date.UTC(y, m, d, h, min) for the clock time as shown to the user. Stepping
 * in wall time avoids DST surprises (+1 hour always moves the clock by one
 * hour). Conversion to a real instant only happens at the edges: when reading
 * the entity state and when writing it back.
 */

export const MINUTE = 60_000;
export const DAY = 1_440 * MINUTE;

export interface WallParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export function wallFromParts(p: WallParts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}

export function partsFromWall(wall: number): WallParts {
  const d = new Date(wall);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/** Wall time of an instant as seen in the given time zone. */
export function wallFromInstant(instant: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(new Date(instant))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute);
}

/** Instant for a wall time in the given time zone (DST gaps resolve forward). */
export function instantFromWall(wall: number, timeZone: string): number {
  let instant = wall - (wallFromInstant(wall, timeZone) - wall);
  // Second pass corrects for offset changes between the guess and the result.
  instant = wall - (wallFromInstant(instant, timeZone) - instant);
  return instant;
}

/** Truncate to whole minutes. */
export function floorMinute(ms: number): number {
  return Math.floor(ms / MINUTE) * MINUTE;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatNaive(wall: number, withDate: boolean, withTime: boolean): string {
  const p = partsFromWall(wall);
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const time = `${pad(p.hour)}:${pad(p.minute)}:00`;
  if (withDate && withTime) return `${date} ${time}`;
  return withDate ? date : time;
}

/** Parse "YYYY-MM-DD", "HH:MM[:SS]" or "YYYY-MM-DD HH:MM[:SS]" into wall time. */
export function parseNaive(value: string): number | undefined {
  const m = /^(?:(\d{4})-(\d{2})-(\d{2}))?[ T]?(?:(\d{2}):(\d{2})(?::\d{2})?)?$/.exec(value.trim());
  if (!m || (!m[1] && !m[4])) return undefined;
  return Date.UTC(
    m[1] ? Number(m[1]) : 1970,
    m[2] ? Number(m[2]) - 1 : 0,
    m[3] ? Number(m[3]) : 1,
    m[4] ? Number(m[4]) : 0,
    m[5] ? Number(m[5]) : 0,
  );
}

export { pad };
