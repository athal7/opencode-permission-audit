import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Permission } from "@opencode-ai/sdk";
import type { DayFile, SidecarEntry } from "../src/types.js";
import {
  DAY_FILE_CAP,
  CACHE_MAX_ENTRIES,
  utcDateStamp,
  sidecarBaseDir,
  sidecarPathForDate,
  normalizePatterns,
  narrowResponse,
  shapeEntry,
  emptyDayFile,
  enforceCap,
  appendCapped,
  readDayFile,
  writeDayFileAtomic,
  recordReply,
  createBoundedCache,
} from "../src/log-store.js";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-permission-log-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function samplePermission(overrides: Partial<Permission> = {}): Permission {
  return {
    id: "perm_1",
    type: "bash",
    sessionID: "session_1",
    messageID: "message_1",
    title: "Run a bash command",
    metadata: {},
    time: { created: 1_700_000_000_000 },
    ...overrides,
  };
}

describe("utcDateStamp", () => {
  it("formats a date as YYYY-MM-DD in UTC", () => {
    const date = new Date("2024-03-15T12:00:00.000Z");
    expect(utcDateStamp(date)).toBe("2024-03-15");
  });

  it("uses UTC, not local time, near a day boundary", () => {
    // 23:30 UTC on Jan 1 — a local timezone west of UTC (e.g. US) would
    // still show Jan 1 locally, but a timezone east of UTC would already
    // show Jan 2. utcDateStamp must always report the UTC date.
    const date = new Date("2024-01-01T23:30:00.000Z");
    expect(utcDateStamp(date)).toBe("2024-01-01");

    const justAfterMidnightUtc = new Date("2024-01-02T00:30:00.000Z");
    expect(utcDateStamp(justAfterMidnightUtc)).toBe("2024-01-02");
  });
});

describe("sidecarBaseDir", () => {
  it("defaults to os.homedir()-based path", () => {
    const dir = sidecarBaseDir("/home/tester");
    expect(dir).toBe("/home/tester/.local/share/opencode/storage/plugin/opencode-permission-log");
  });

  it("uses the provided homeDir override", () => {
    const dir = sidecarBaseDir("/custom/home");
    expect(dir).toBe("/custom/home/.local/share/opencode/storage/plugin/opencode-permission-log");
  });
});

describe("sidecarPathForDate", () => {
  it("builds the exact path shape for a date", () => {
    const date = new Date("2024-03-15T12:00:00.000Z");
    const path = sidecarPathForDate(date, "/home/tester");
    expect(path).toBe(
      "/home/tester/.local/share/opencode/storage/plugin/opencode-permission-log/2024-03-15.json"
    );
  });
});

describe("normalizePatterns", () => {
  it("returns an empty array for undefined", () => {
    expect(normalizePatterns(undefined)).toEqual([]);
  });

  it("wraps a single string pattern in an array", () => {
    expect(normalizePatterns("src/**")).toEqual(["src/**"]);
  });

  it("copies a string array pattern without sharing a reference", () => {
    const input = ["src/**", "test/**"];
    const result = normalizePatterns(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);

    result.push("mutated/**");
    expect(input).toEqual(["src/**", "test/**"]);
  });
});

describe("narrowResponse", () => {
  it.each(["once", "always", "reject"] as const)("passes through %s", (value) => {
    expect(narrowResponse(value)).toBe(value);
  });

  it("returns null for an unrecognized literal", () => {
    expect(narrowResponse("bogus")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(narrowResponse("")).toBeNull();
  });
});

describe("shapeEntry", () => {
  const timestamp = "2024-03-15T12:00:00.000Z";

  it("builds a SidecarEntry from a Permission with a string pattern", () => {
    const permission = samplePermission({ pattern: "src/**" });
    const entry = shapeEntry(permission, "always", timestamp);
    expect(entry).toEqual<SidecarEntry>({
      timestamp,
      sessionID: "session_1",
      permission: "bash",
      patterns: ["src/**"],
      response: "always",
    });
  });

  it("builds a SidecarEntry from a Permission with a string[] pattern", () => {
    const permission = samplePermission({ pattern: ["src/**", "test/**"] });
    const entry = shapeEntry(permission, "once", timestamp);
    expect(entry.patterns).toEqual(["src/**", "test/**"]);
  });

  it("builds a SidecarEntry from a Permission with no pattern", () => {
    const permission = samplePermission({ pattern: undefined });
    const entry = shapeEntry(permission, "reject", timestamp);
    expect(entry.patterns).toEqual([]);
  });
});

describe("emptyDayFile", () => {
  it("returns the correct shape for a given date", () => {
    const date = new Date("2024-03-15T12:00:00.000Z");
    expect(emptyDayFile(date)).toEqual<DayFile>({
      version: 1,
      date: "2024-03-15",
      entries: [],
    });
  });
});

function makeEntries(count: number): SidecarEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: `2024-03-15T00:00:${String(i).padStart(2, "0")}.000Z`,
    sessionID: "session_1",
    permission: "bash",
    patterns: [],
    response: "once" as const,
  }));
}

describe("enforceCap", () => {
  it("leaves entries unchanged when at or under the cap", () => {
    const entries = makeEntries(3);
    expect(enforceCap(entries, 5)).toEqual(entries);
  });

  it("keeps only the last `cap` entries, dropping the earliest", () => {
    const entries = makeEntries(5);
    const result = enforceCap(entries, 3);
    expect(result).toEqual(entries.slice(-3));
    expect(result.map((e) => e.timestamp)).toEqual([
      "2024-03-15T00:00:02.000Z",
      "2024-03-15T00:00:03.000Z",
      "2024-03-15T00:00:04.000Z",
    ]);
  });

  it("defaults the cap to DAY_FILE_CAP", () => {
    const entries = makeEntries(DAY_FILE_CAP + 10);
    const result = enforceCap(entries);
    expect(result).toHaveLength(DAY_FILE_CAP);
    expect(result).toEqual(entries.slice(-DAY_FILE_CAP));
  });
});

describe("appendCapped", () => {
  it("grows the entries array when appending under the cap", () => {
    const dayFile = emptyDayFile(new Date("2024-03-15T00:00:00.000Z"));
    const entry = makeEntries(1)[0];
    const result = appendCapped(dayFile, entry, 5);
    expect(result.entries).toEqual([entry]);
  });

  it("evicts the oldest entry when appending over the cap", () => {
    const dayFile: DayFile = { version: 1, date: "2024-03-15", entries: makeEntries(3) };
    const newEntry = { ...makeEntries(1)[0], timestamp: "2024-03-15T00:00:99.000Z" };
    const result = appendCapped(dayFile, newEntry, 3);
    expect(result.entries).toHaveLength(3);
    expect(result.entries[result.entries.length - 1]).toEqual(newEntry);
    expect(result.entries[0].timestamp).toBe("2024-03-15T00:00:01.000Z");
  });

  it("does not mutate the input dayFile", () => {
    const originalEntries = makeEntries(2);
    const dayFile: DayFile = { version: 1, date: "2024-03-15", entries: originalEntries };
    const newEntry = makeEntries(1)[0];
    const result = appendCapped(dayFile, newEntry, 5);
    expect(dayFile.entries).toBe(originalEntries);
    expect(dayFile.entries).toHaveLength(2);
    expect(result).not.toBe(dayFile);
    expect(result.entries).not.toBe(originalEntries);
  });
});

describe("readDayFile", () => {
  it("returns null when the file is missing", async () => {
    const dir = await makeTmpDir();
    const result = await readDayFile(join(dir, "missing.json"));
    expect(result).toBeNull();
  });

  it("returns null for malformed JSON without throwing", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "bad.json");
    await writeFile(path, "{ not valid json", "utf8");
    await expect(readDayFile(path)).resolves.toBeNull();
  });

  it("returns the parsed DayFile for a valid file", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "good.json");
    const dayFile: DayFile = { version: 1, date: "2024-03-15", entries: makeEntries(2) };
    await writeFile(path, JSON.stringify(dayFile), "utf8");
    await expect(readDayFile(path)).resolves.toEqual(dayFile);
  });
});

describe("writeDayFileAtomic", () => {
  it("writes valid JSON that can be read back", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "out.json");
    const dayFile: DayFile = { version: 1, date: "2024-03-15", entries: makeEntries(1) };
    await writeDayFileAtomic(path, dayFile);
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toEqual(dayFile);
  });

  it("creates nested directories that don't exist yet", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "nested", "deeper", "out.json");
    const dayFile = emptyDayFile(new Date("2024-03-15T00:00:00.000Z"));
    await writeDayFileAtomic(path, dayFile);
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toEqual(dayFile);
  });

  it("leaves no leftover .tmp file after a successful write", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "out.json");
    const dayFile = emptyDayFile(new Date("2024-03-15T00:00:00.000Z"));
    await writeDayFileAtomic(path, dayFile);
    await expect(readFile(`${path}.tmp`, "utf8")).rejects.toThrow();
  });
});

describe("recordReply", () => {
  it("creates the directory and file for a fresh day", async () => {
    const homeDir = await makeTmpDir();
    const entry: SidecarEntry = {
      timestamp: "2024-03-15T12:00:00.000Z",
      sessionID: "session_1",
      permission: "bash",
      patterns: ["src/**"],
      response: "always",
    };
    await recordReply(entry, { homeDir });
    const path = sidecarPathForDate(new Date(entry.timestamp), homeDir);
    const dayFile = await readDayFile(path);
    expect(dayFile?.entries).toEqual([entry]);
  });

  it("appends to an existing day file, growing its entries", async () => {
    const homeDir = await makeTmpDir();
    const first: SidecarEntry = {
      timestamp: "2024-03-15T10:00:00.000Z",
      sessionID: "session_1",
      permission: "bash",
      patterns: [],
      response: "once",
    };
    const second: SidecarEntry = {
      timestamp: "2024-03-15T11:00:00.000Z",
      sessionID: "session_2",
      permission: "edit",
      patterns: ["*.ts"],
      response: "reject",
    };
    await recordReply(first, { homeDir });
    await recordReply(second, { homeDir });
    const path = sidecarPathForDate(new Date(first.timestamp), homeDir);
    const dayFile = await readDayFile(path);
    expect(dayFile?.entries).toEqual([first, second]);
  });

  it("enforces the cap across multiple calls exceeding DAY_FILE_CAP", async () => {
    const homeDir = await makeTmpDir();
    const cap = 3;
    for (let i = 0; i < cap + 2; i++) {
      const entry: SidecarEntry = {
        timestamp: `2024-03-15T00:00:${String(i).padStart(2, "0")}.000Z`,
        sessionID: "session_1",
        permission: "bash",
        patterns: [],
        response: "once",
      };
      await recordReply(entry, { homeDir, cap });
    }
    const path = sidecarPathForDate(new Date("2024-03-15T00:00:00.000Z"), homeDir);
    const dayFile = await readDayFile(path);
    expect(dayFile?.entries).toHaveLength(cap);
    expect(dayFile?.entries[0].timestamp).toBe("2024-03-15T00:00:02.000Z");
    expect(dayFile?.entries[cap - 1].timestamp).toBe("2024-03-15T00:00:04.000Z");
  });

  it("resolves without throwing and invokes onError on a forced IO failure", async () => {
    const tmpParent = await makeTmpDir();
    // Point homeDir at a path segment that is a file, not a directory, so
    // any attempt to mkdir/write beneath it fails.
    const fileAsHomeDir = join(tmpParent, "not-a-directory");
    await writeFile(fileAsHomeDir, "i am a file", "utf8");

    const entry: SidecarEntry = {
      timestamp: "2024-03-15T12:00:00.000Z",
      sessionID: "session_1",
      permission: "bash",
      patterns: [],
      response: "always",
    };

    let caught: unknown;
    await expect(
      recordReply(entry, {
        homeDir: fileAsHomeDir,
        onError: (e) => {
          caught = e;
        },
      })
    ).resolves.toBeUndefined();
    expect(caught).toBeDefined();
  });
});

describe("createBoundedCache", () => {
  it("supports basic set/has/take/size behavior", () => {
    const cache = createBoundedCache<string, number>();
    expect(cache.size).toBe(0);
    cache.set("a", 1);
    expect(cache.has("a")).toBe(true);
    expect(cache.size).toBe(1);
    expect(cache.take("a")).toBe(1);
  });

  it("deletes on take — a second take returns undefined", () => {
    const cache = createBoundedCache<string, number>();
    cache.set("a", 1);
    expect(cache.take("a")).toBe(1);
    expect(cache.take("a")).toBeUndefined();
    expect(cache.has("a")).toBe(false);
  });

  it("evicts the oldest key first (FIFO) once maxEntries is exceeded", () => {
    const cache = createBoundedCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.size).toBe(2);
  });

  it("defaults maxEntries to CACHE_MAX_ENTRIES", () => {
    const cache = createBoundedCache<number, number>();
    for (let i = 0; i < CACHE_MAX_ENTRIES; i++) {
      cache.set(i, i);
    }
    expect(cache.size).toBe(CACHE_MAX_ENTRIES);
    cache.set(CACHE_MAX_ENTRIES, CACHE_MAX_ENTRIES);
    expect(cache.size).toBe(CACHE_MAX_ENTRIES);
    expect(cache.has(0)).toBe(false);
  });
});
