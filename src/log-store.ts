import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { Permission } from "@opencode-ai/sdk";
import type { DayFile, ReplyResponse, SidecarEntry } from "./types.js";

/** Maximum number of entries retained per day file. */
export const DAY_FILE_CAP = 500;

/** Default maximum number of entries retained in a {@link BoundedCache}. */
export const CACHE_MAX_ENTRIES = 1000;

const RECOGNIZED_RESPONSES: ReadonlySet<string> = new Set(["once", "always", "reject"]);

/** Formats a date as "YYYY-MM-DD" using UTC fields (never the local timezone). */
export function utcDateStamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Base directory under which all sidecar day files live. */
export function sidecarBaseDir(homeDir: string = homedir()): string {
  return join(homeDir, ".local", "share", "opencode", "storage", "plugin", "opencode-permission-log");
}

/** Full path to the sidecar file for the given date. */
export function sidecarPathForDate(date: Date, homeDir?: string): string {
  return join(sidecarBaseDir(homeDir), `${utcDateStamp(date)}.json`);
}

/** Normalizes a Permission's `pattern` field into an always-defined array, copying any input array. */
export function normalizePatterns(pattern?: string | string[]): string[] {
  if (pattern === undefined) return [];
  if (typeof pattern === "string") return [pattern];
  return [...pattern];
}

/** Narrows an arbitrary response string to a {@link ReplyResponse}, or null if unrecognized. */
export function narrowResponse(response: string): ReplyResponse | null {
  return RECOGNIZED_RESPONSES.has(response) ? (response as ReplyResponse) : null;
}

/** Builds a {@link SidecarEntry} from a raw SDK Permission and a narrowed reply. */
export function shapeEntry(permission: Permission, response: ReplyResponse, timestamp: string): SidecarEntry {
  return {
    timestamp,
    sessionID: permission.sessionID,
    permission: permission.type,
    patterns: normalizePatterns(permission.pattern),
    response,
  };
}

/** Builds an empty day file for the given date. */
export function emptyDayFile(date: Date): DayFile {
  return { version: 1, date: utcDateStamp(date), entries: [] };
}

/**
 * Keeps only the last `cap` entries, evicting the oldest first.
 *
 * Cap policy: oldest-evicted (`entries.slice(-cap)`), because audit
 * consumers care about *recent* behavior; freezing at the first N would
 * silently miss later signal.
 */
export function enforceCap(entries: SidecarEntry[], cap: number = DAY_FILE_CAP): SidecarEntry[] {
  if (entries.length <= cap) return [...entries];
  return entries.slice(-cap);
}

/** Returns a new DayFile with `entry` appended and the cap enforced. Never mutates `dayFile`. */
export function appendCapped(dayFile: DayFile, entry: SidecarEntry, cap: number = DAY_FILE_CAP): DayFile {
  return {
    ...dayFile,
    entries: enforceCap([...dayFile.entries, entry], cap),
  };
}

/** Reads and parses a day file. Fail-open: returns null on any missing/parse/IO error, never throws. */
export async function readDayFile(path: string): Promise<DayFile | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as DayFile;
  } catch {
    return null;
  }
}

/** Writes a day file atomically: write to a `.tmp` sibling, then rename over the target. */
export async function writeDayFileAtomic(path: string, dayFile: DayFile): Promise<void> {
  const dir = join(path, "..");
  await mkdir(dir, { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(dayFile, null, 2), "utf8");
  await rename(tmpPath, path);
}

/**
 * Orchestrates a single reply's persistence: locate today's day file, append
 * the entry with the cap enforced, and write it back atomically.
 *
 * Fail-open by design: a plugin's event hook running on the hot path of a
 * permission reply must never block or crash that flow because of a logging
 * failure. All errors are caught and reported via `opts.onError`; this
 * promise never rejects.
 */
export async function recordReply(
  entry: SidecarEntry,
  opts?: { homeDir?: string; cap?: number; onError?: (e: unknown) => void }
): Promise<void> {
  try {
    const date = new Date(entry.timestamp);
    const path = sidecarPathForDate(date, opts?.homeDir);
    const existing = await readDayFile(path);
    const dayFile = existing ?? emptyDayFile(date);
    const updated = appendCapped(dayFile, entry, opts?.cap);
    await writeDayFileAtomic(path, updated);
  } catch (e) {
    opts?.onError?.(e);
  }
}

/** A fixed-size, insertion-ordered cache used to correlate `permission.updated` with `permission.replied`. */
export interface BoundedCache<K, V> {
  set(key: K, value: V): void;
  take(key: K): V | undefined;
  has(key: K): boolean;
  readonly size: number;
}

/**
 * Creates a bounded cache backed by a JS `Map`.
 *
 * Eviction policy: fixed-size FIFO via `Map` insertion order — O(1) evict,
 * no timers. This is a backstop for dead/mid-ask sessions (a permission
 * that was seen but never replied to, or a session that ended before a
 * reply arrived), not a strict-correctness cache; losing one correlation
 * only means one unlogged reply, it never breaks the real permission flow.
 */
export function createBoundedCache<K, V>(maxEntries: number = CACHE_MAX_ENTRIES): BoundedCache<K, V> {
  const map = new Map<K, V>();

  return {
    set(key: K, value: V): void {
      if (map.size >= maxEntries && !map.has(key)) {
        const oldestKey = map.keys().next().value as K;
        map.delete(oldestKey);
      }
      map.set(key, value);
    },
    take(key: K): V | undefined {
      const value = map.get(key);
      map.delete(key);
      return value;
    },
    has(key: K): boolean {
      return map.has(key);
    },
    get size(): number {
      return map.size;
    },
  };
}
