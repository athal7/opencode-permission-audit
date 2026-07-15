import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, Permission } from "@opencode-ai/sdk";
import type { PluginInput } from "@opencode-ai/plugin";

// plugin.ts resolves the sidecar homeDir via node:os homedir() (through
// log-store's default parameter), so this file mocks node:os to redirect
// all file IO at a controllable temp directory without touching the real
// user home directory.
let homeDir: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => homeDir,
  };
});

const { default: plugin } = await import("../src/plugin.js");
const { sidecarPathForDate, readDayFile } = await import("../src/log-store.js");

function permissionUpdated(overrides: Partial<Permission> = {}): Event {
  return {
    type: "permission.updated",
    properties: {
      id: "perm_a",
      type: "bash",
      sessionID: "session_1",
      messageID: "message_1",
      title: "Run a bash command",
      metadata: {},
      time: { created: 1_700_000_000_000 },
      ...overrides,
    },
  } as Event;
}

function permissionReplied(permissionID: string, response: string, sessionID = "session_1"): Event {
  return {
    type: "permission.replied",
    properties: { sessionID, permissionID, response },
  } as Event;
}

describe("plugin", () => {
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "opencode-permission-log-plugin-test-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  async function todaysDayFile() {
    const path = sidecarPathForDate(new Date(), homeDir);
    return readDayFile(path);
  }

  it("logs one entry when a permission.updated is followed by a permission.replied for the same id", async () => {
    const hooks = await plugin({} as PluginInput);
    await hooks.event?.({ event: permissionUpdated({ id: "perm_a", pattern: "src/**" }) });
    await hooks.event?.({ event: permissionReplied("perm_a", "always") });

    const dayFile = await todaysDayFile();
    expect(dayFile?.entries).toHaveLength(1);
    expect(dayFile?.entries[0]).toMatchObject({
      sessionID: "session_1",
      permission: "bash",
      patterns: ["src/**"],
      response: "always",
    });
  });

  it("does not write an entry when permission.replied has no prior permission.updated for that id", async () => {
    const hooks = await plugin({} as PluginInput);
    await hooks.event?.({ event: permissionReplied("perm_unknown", "always") });

    const dayFile = await todaysDayFile();
    expect(dayFile).toBeNull();
  });

  it("handles the cascade case: two pending permissions replied to independently both get logged and correlated correctly", async () => {
    const hooks = await plugin({} as PluginInput);
    await hooks.event?.({ event: permissionUpdated({ id: "perm_a", type: "bash", sessionID: "session_1" }) });
    await hooks.event?.({ event: permissionUpdated({ id: "perm_b", type: "edit", sessionID: "session_1" }) });

    await hooks.event?.({ event: permissionReplied("perm_a", "always", "session_1") });
    await hooks.event?.({ event: permissionReplied("perm_b", "once", "session_1") });

    const dayFile = await todaysDayFile();
    expect(dayFile?.entries).toHaveLength(2);
    expect(dayFile?.entries).toContainEqual(
      expect.objectContaining({ permission: "bash", response: "always" })
    );
    expect(dayFile?.entries).toContainEqual(
      expect.objectContaining({ permission: "edit", response: "once" })
    );
  });

  it("ignores unrelated event types without crashing", async () => {
    const hooks = await plugin({} as PluginInput);
    await expect(
      hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "session_1" } } as Event })
    ).resolves.not.toThrow();

    const dayFile = await todaysDayFile();
    expect(dayFile).toBeNull();
  });
});
