import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  normalizeBashApprovalPattern,
  bashApprovalPatternToRegExp,
  getBashApprovalPatternRules,
  commandMatchesBashApprovalPattern,
  commandSegmentMatchesBashApprovalPattern,
  hasBashApprovalShellControl,
  evaluateCommandDecision,
  loadOmpPatternsAndMode,
  logMatchOutcome,
} from "../omp-permission-log.js";
import { parseSimpleYaml } from "../permission-audit/scripts/audit.mjs";

let tempDir: string;

describe("omp-permission-log", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "omp-permission-log-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("pattern matching and normalization", () => {
    it("normalizes spacing", () => {
      expect(normalizeBashApprovalPattern("  npm   install  ")).toBe("npm install");
    });

    it("converts wildcard to RegExp", () => {
      const regex = bashApprovalPatternToRegExp("npm install*");
      expect(regex.test("npm install")).toBe(true);
      expect(regex.test("npm install vitest")).toBe(true);
      expect(regex.test("npm run test")).toBe(false);
    });

    it("handles getBashApprovalPatternRules correctly", () => {
      const rawRules = [
        { match: "npm install*", approval: "allow" },
        { match: "rm -rf*", approval: "deny" },
        { match: "sudo*", approval: "invalid" }, // unrecognized approval
        "not-an-object",
      ];
      const rules = getBashApprovalPatternRules(rawRules);
      expect(rules).toHaveLength(2);
      expect(rules[0]).toEqual({ match: "npm install*", approval: "allow" });
      expect(rules[1]).toEqual({ match: "rm -rf*", approval: "deny" });
    });

    it("correctly identifies compound command shell control", () => {
      // standard command
      expect(hasBashApprovalShellControl("npm install")).toBe(false);
      // compound/reinterpretations
      expect(hasBashApprovalShellControl("npm install && rm -rf")).toBe(true);
      expect(hasBashApprovalShellControl("npm install ; rm -rf")).toBe(true);
    });

    it("evaluates simple command matches correctly", () => {
      expect(commandMatchesBashApprovalPattern("npm install vitest", "npm install*")).toBe(true);
      expect(commandMatchesBashApprovalPattern("npm install vitest", "npm run*")).toBe(false);
    });

    it("evaluates command segment matches correctly", () => {
      const pattern = "rm -rf*";
      expect(commandSegmentMatchesBashApprovalPattern("npm install && rm -rf foo", pattern)).toBe(true);
      expect(commandSegmentMatchesBashApprovalPattern("rm -rf foo", pattern)).toBe(true);
      expect(commandSegmentMatchesBashApprovalPattern("npm install", pattern)).toBe(false);
    });
  });

  describe("evaluateCommandDecision", () => {
    const rules = [
      { match: "npm install*", approval: "allow" as const },
      { match: "rm -rf*", approval: "deny" as const },
      { match: "docker run*", approval: "prompt" as const },
    ];

    it("returns deny if matching a deny rule", () => {
      const res = evaluateCommandDecision("rm -rf package-lock.json", rules, "yolo");
      expect(res).toEqual({ decision: "deny", pattern: "rm -rf*" });
    });

    it("returns prompt for critical patterns", () => {
      const res = evaluateCommandDecision("sudo rm -rf /", rules, "yolo");
      expect(res.decision).toBe("prompt");
      expect(res.pattern).toBe("critical-pattern");
    });

    it("returns allow if matching an allow rule", () => {
      const res = evaluateCommandDecision("npm install --save-dev vitest", rules, "yolo");
      expect(res).toEqual({ decision: "allow", pattern: "npm install*" });
    });

    it("returns prompt if matching a prompt rule", () => {
      const res = evaluateCommandDecision("docker run -d redis", rules, "yolo");
      expect(res).toEqual({ decision: "prompt", pattern: "docker run*" });
    });

    it("falls back to allow under yolo if no pattern matches", () => {
      const res = evaluateCommandDecision("git status", rules, "yolo");
      expect(res).toEqual({ decision: "allow", pattern: null });
    });

    it("falls back to prompt under always-ask if no pattern matches", () => {
      const res = evaluateCommandDecision("git status", rules, "always-ask");
      expect(res).toEqual({ decision: "prompt", pattern: null });
    });
  });

  describe("loadOmpPatternsAndMode", () => {
    it("loads and parses yml files in project and global dirs", async () => {
      // Create a mock project .omp/config.yml
      const projectOmpDir = join(tempDir, ".omp");
      await mkdir(projectOmpDir);
      await writeFile(
        join(projectOmpDir, "config.yml"),
        `
bash.patterns:
  - match: "npm install*"
    approval: allow
tools:
  approvalMode: yolo
`,
        "utf8"
      );

      // Create a mock global ~/.omp/agent/config.yml
      const globalHomeDir = join(tempDir, "home");
      const globalOmpDir = join(globalHomeDir, ".omp", "agent");
      await mkdir(globalOmpDir, { recursive: true });
      await writeFile(
        join(globalOmpDir, "config.yml"),
        `
bash.patterns:
  - match: "rm -rf*"
    approval: deny
tools.approvalMode: always-ask
`,
        "utf8"
      );

      const { rules, mode } = loadOmpPatternsAndMode(tempDir, globalHomeDir);
      expect(mode).toBe("yolo"); // project wins over global
      expect(rules).toHaveLength(2);
      expect(rules[0]).toEqual({ match: "npm install*", approval: "allow" });
      expect(rules[1]).toEqual({ match: "rm -rf*", approval: "deny" });
    });
  });

  describe("logMatchOutcome", () => {
    it("saves day files atomically under custom homeDir", async () => {
      const homeDir = join(tempDir, "home");
      const entry = {
        timestamp: "2026-08-13T12:00:00.000Z",
        sessionID: "sess_1",
        command: "npm install",
        pattern: "npm install*",
        decision: "allow" as const,
      };

      await logMatchOutcome(homeDir, entry);

      const filePath = join(
        homeDir,
        ".local",
        "share",
        "omp",
        "storage",
        "plugin",
        "omp-permission-log",
        "2026-08-13.json"
      );
      expect(existsSync(filePath)).toBe(true);

      const content = JSON.parse(await readFile(filePath, "utf8"));
      expect(content.version).toBe(1);
      expect(content.date).toBe("2026-08-13");
      expect(content.entries).toHaveLength(1);
      expect(content.entries[0]).toEqual(entry);
    });
  });
});

describe("audit.mjs simple yaml parsing", () => {
  it("correctly parses complex yml formats (quoted, comments, nested)", () => {
    const yaml = `
# Global config
bash.patterns:
  - match: "npm run *"
    approval: "allow"
  - match: 'rm -rf *'
    approval: deny # unsafe
tools:
  approvalMode: yolo
`;
    const res = parseSimpleYaml(yaml);
    expect(res["tools.approvalMode"]).toBe("yolo");
    expect(res["bash.patterns"]).toHaveLength(2);
    expect(res["bash.patterns"][0]).toEqual({ match: "npm run *", approval: "allow" });
    expect(res["bash.patterns"][1]).toEqual({ match: "rm -rf *", approval: "deny" });
  });

  it("handles alternative nested layout", () => {
    const yaml = `
bash:
  patterns:
    - match: "npm install"
      approval: allow
tools.approvalMode: always-ask
`;
    const res = parseSimpleYaml(yaml);
    expect(res["tools.approvalMode"]).toBe("always-ask");
    expect(res["bash.patterns"]).toHaveLength(1);
    expect(res["bash.patterns"][0]).toEqual({ match: "npm install", approval: "allow" });
  });
});

describe("audit.mjs script execution verification", () => {
  it("runs correctly with --omp flag and processes mock sidecars", async () => {
    const projectDir = join(tempDir, "project");
    const sidecarDir = join(tempDir, "sidecars");
    await mkdir(projectDir, { recursive: true });
    await mkdir(sidecarDir, { recursive: true });

    // Create config.yml
    await mkdir(join(projectDir, ".omp"), { recursive: true });
    await writeFile(
      join(projectDir, ".omp", "config.yml"),
      `
bash.patterns:
  - match: "npm run test"
    approval: allow
  - match: "rm -rf *"
    approval: deny
`,
      "utf8"
    );

    // Create sidecar log
    const dateStr = "2026-08-13";
    const dayFile = {
      version: 1,
      date: dateStr,
      entries: [
        {
          timestamp: "2026-08-13T10:00:00.000Z",
          sessionID: "sess_x",
          command: "npm run test",
          pattern: "npm run test",
          decision: "allow",
        },
        {
          timestamp: "2026-08-13T10:05:00.000Z",
          sessionID: "sess_x",
          command: "rm -rf node_modules",
          pattern: "rm -rf *",
          decision: "deny",
        },
        {
          timestamp: "2026-08-13T10:10:00.000Z",
          sessionID: "sess_x",
          command: "node run.js",
          pattern: null,
          decision: "prompt",
        }
      ]
    };
    await writeFile(join(sidecarDir, `${dateStr}.json`), JSON.stringify(dayFile), "utf8");

    // Execute audit.mjs script via shell
    const scriptPath = join(process.cwd(), "permission-audit", "scripts", "audit.mjs");
    const command = `node ${scriptPath} --project "${projectDir}" --sidecar "${sidecarDir}" --omp`;

    const stdout = execSync(command, { encoding: "utf8" });
    const report = JSON.parse(stdout);

    expect(report.sidecarDir).toBe(resolve(sidecarDir));
    expect(report.totals.entriesScanned).toBe(3);
    expect(report.friction).toHaveLength(1);
    expect(report.friction[0].pattern).toBe("(none)");
    expect(report.denials).toHaveLength(1);
    expect(report.denials[0].pattern).toBe("rm -rf *");
    expect(report.active).toHaveLength(1);
    expect(report.active[0].pattern).toBe("npm run test");
  });
});
