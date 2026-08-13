import type { HookAPI } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse } from "yaml";

export interface OmpSidecarEntry {
  timestamp: string;     // ISO 8601
  sessionID: string;
  command: string;       // the full executed command
  pattern: string | null; // the matched pattern in bash.patterns, or null if none
  decision: "allow" | "prompt" | "deny";
}

export interface OmpDayFile {
  version: 1;
  date: string;          // "YYYY-MM-DD" (UTC)
  entries: OmpSidecarEntry[];
}

const DAY_FILE_CAP = 500;

export interface BashApprovalPatternRule {
  match: string;
  approval: "allow" | "prompt" | "deny";
}

export function normalizeBashApprovalPattern(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export function bashApprovalPatternToRegExp(pattern: string): RegExp {
  const escaped = normalizeBashApprovalPattern(pattern)
    .split("*")
    .map(part => part.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "u");
}

function normalizeBashPatternApproval(value: unknown): "allow" | "prompt" | "deny" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return ["allow", "prompt", "deny"].includes(normalized) ? (normalized as any) : undefined;
}

export function getBashApprovalPatternRules(value: unknown): BashApprovalPatternRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
      const record = item as Record<string, unknown>;
      if (typeof record.match !== "string") return undefined;
      const match = normalizeBashApprovalPattern(record.match);
      const approval = normalizeBashPatternApproval(record.approval);
      return match.length > 0 && approval ? { match, approval } : undefined;
    })
    .filter((rule): rule is BashApprovalPatternRule => !!rule);
}

function tokenizeShellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  let buffer = "";
  let inSingle = false;
  let inDouble = false;
  const pushBuffer = () => {
    if (buffer.length > 0) {
      current.push(buffer);
      buffer = "";
    }
  };
  const pushSegment = () => {
    pushBuffer();
    if (current.length > 0) segments.push(current);
    current = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
        continue;
      }
      buffer += ch;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < command.length) {
        const next = command[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          buffer += next;
          i++;
          continue;
        }
      }
      if (ch === '"') {
        inDouble = false;
        continue;
      }
      buffer += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      buffer += command[i + 1];
      i++;
      continue;
    }
    if (ch === " " || ch === "\t") {
      pushBuffer();
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
      pushSegment();
      continue;
    }
    buffer += ch;
  }
  pushSegment();
  return segments;
}

function bashCommandSegments(command: string): string[] {
  return tokenizeShellSegments(command)
    .map(segment => segment.join(" "))
    .filter(segment => segment.length > 0);
}

const BASH_APPROVAL_SHELL_CONTROL_CHARS: Record<string, true> = {
  "\n": true,
  "\r": true,
  ";": true,
  "&": true,
  "|": true,
  "<": true,
  ">": true,
  "`": true,
  $: true,
  "(": true,
  ")": true,
};
const BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE = /(?:^|[ \t])(?:-[^-]*[ce]|--(?:command|eval))(?:[= \t]|$)/u;

export function hasBashApprovalShellControl(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let hasReinterpretableShellControl = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") {
        quote = undefined;
      } else if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) {
        hasReinterpretableShellControl = true;
      }
      continue;
    }
    if (ch === "\\") {
      const escaped = command[i + 1];
      if (escaped && Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, escaped)) {
        hasReinterpretableShellControl = true;
      }
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = undefined;
        continue;
      }
      if (ch === "`" || ch === "$") return true;
      if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) hasReinterpretableShellControl = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) return true;
  }
  return hasReinterpretableShellControl && BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE.test(command);
}

export const CRITICAL_BASH_PATTERNS = [
  /\brm\s+-[a-z]*[rRfF][a-z]*\s+\//i,
  /\bsudo\s+rm\b/i,
  /\bchmod\s+-R\s+[0-7]+\s+\//i,
  /\bchmod\s+-R\s+[ugoa+\-=rwxXst,]+\s+\//,
  /\bchown\s+-R\s+\S+\s+\//i,
  /:\(\)\s*\{\s*:\s*\|\s*:/i,
  />\s*\/dev\/sd[a-z]/i,
  /\bmkfs(\.|\b)/i,
  /\bdd\s+if=.+of=\/dev\//i,
  /\bshred\s+\/dev\//i,
  /\bcryptsetup\b/i,
];

export function commandMatchesBashApprovalPattern(command: string, pattern: string): boolean {
  const normalizedCommand = normalizeBashApprovalPattern(command);
  if (normalizedCommand.length === 0) return false;
  return bashApprovalPatternToRegExp(pattern).test(normalizedCommand);
}

export function commandSegmentMatchesBashApprovalPattern(command: string, pattern: string): boolean {
  const regex = bashApprovalPatternToRegExp(pattern);
  const normalizedCommand = normalizeBashApprovalPattern(command);
  if (normalizedCommand.length === 0) return false;
  if (regex.test(normalizedCommand)) return true;
  return bashCommandSegments(command).some(segment => regex.test(segment));
}

export function bashApprovalRuleMatches(command: string, rule: BashApprovalPatternRule): boolean {
  if (rule.approval === "allow") {
    if (hasBashApprovalShellControl(command)) return false;
    return commandMatchesBashApprovalPattern(command, rule.match);
  }
  return commandSegmentMatchesBashApprovalPattern(command, rule.match);
}

export function findBashApprovalPatternRule(
  command: string,
  rules: readonly BashApprovalPatternRule[],
): BashApprovalPatternRule | undefined {
  return rules.find(rule => bashApprovalRuleMatches(command, rule));
}

export function getSetting(obj: any, path: string[]): any {
  if (!obj) return undefined;
  let current = obj;
  let foundNested = true;
  for (const key of path) {
    if (current && typeof current === "object" && key in current) {
      current = current[key];
    } else {
      foundNested = false;
      break;
    }
  }
  if (foundNested) return current;

  const flatKey = path.join(".");
  if (obj && typeof obj === "object" && flatKey in obj) {
    return obj[flatKey];
  }
  return undefined;
}

export function loadOmpPatternsAndMode(cwd: string, homeDirectory: string = homedir()): { rules: BashApprovalPatternRule[]; mode: string } {
  let projectRules: BashApprovalPatternRule[] = [];
  let globalRules: BashApprovalPatternRule[] = [];
  let projectMode: string | null = null;
  let globalMode: string | null = null;

  const projectPaths = [
    join(cwd, ".omp", "config.yml"),
    join(cwd, ".omp", "config.yaml"),
  ];

  const globalPaths = [
    join(homeDirectory, ".omp", "agent", "config.yml"),
    join(homeDirectory, ".omp", "agent", "config.yaml"),
    join(homeDirectory, ".omp", "config.yml"),
    join(homeDirectory, ".omp", "config.yaml"),
  ];

  for (const path of projectPaths) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = parse(raw);
        if (parsed && typeof parsed === "object") {
          const patternsSetting = getSetting(parsed, ["bash", "patterns"]) ?? getSetting(parsed, ["bash.patterns"]);
          if (Array.isArray(patternsSetting)) {
            projectRules.push(...getBashApprovalPatternRules(patternsSetting));
          }
          const modeSetting = getSetting(parsed, ["tools", "approvalMode"]) ?? getSetting(parsed, ["tools.approvalMode"]);
          if (typeof modeSetting === "string") {
            projectMode = modeSetting;
          }
        }
      } catch (e) {}
      break;
    }
  }

  for (const path of globalPaths) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = parse(raw);
        if (parsed && typeof parsed === "object") {
          const patternsSetting = getSetting(parsed, ["bash", "patterns"]) ?? getSetting(parsed, ["bash.patterns"]);
          if (Array.isArray(patternsSetting)) {
            globalRules.push(...getBashApprovalPatternRules(patternsSetting));
          }
          const modeSetting = getSetting(parsed, ["tools", "approvalMode"]) ?? getSetting(parsed, ["tools.approvalMode"]);
          if (typeof modeSetting === "string") {
            globalMode = modeSetting;
          }
        }
      } catch (e) {}
      break;
    }
  }

  return {
    rules: [...projectRules, ...globalRules],
    mode: projectMode || globalMode || "yolo",
  };
}

export function evaluateCommandDecision(
  command: string,
  rules: readonly BashApprovalPatternRule[],
  mode: string
): { decision: "allow" | "prompt" | "deny"; pattern: string | null } {
  const patternRule = findBashApprovalPatternRule(command, rules);
  if (patternRule?.approval === "deny") {
    return { decision: "deny", pattern: patternRule.match };
  }
  const isCritical = CRITICAL_BASH_PATTERNS.some(p => p.test(command));
  if (isCritical) {
    return { decision: "prompt", pattern: "critical-pattern" };
  }
  if (patternRule?.approval === "allow") {
    return { decision: "allow", pattern: patternRule.match };
  }
  if (patternRule?.approval === "prompt") {
    return { decision: "prompt", pattern: patternRule.match };
  }

  // If no pattern rule matched, it depends on approvalMode.
  // In yolo mode, it allows. In always-ask or write mode, it prompts.
  if (mode === "yolo") {
    return { decision: "allow", pattern: null };
  }
  return { decision: "prompt", pattern: null };
}

function utcDateStamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function logMatchOutcome(
  homeDir: string,
  entry: OmpSidecarEntry
): Promise<void> {
  try {
    const date = new Date(entry.timestamp);
    const dateStr = utcDateStamp(date);
    const baseDir = join(
      homeDir,
      ".local",
      "share",
      "omp",
      "storage",
      "plugin",
      "omp-permission-log"
    );
    const filePath = join(baseDir, `${dateStr}.json`);

    await mkdir(baseDir, { recursive: true });

    let dayFile: OmpDayFile;
    if (existsSync(filePath)) {
      try {
        const raw = await readFile(filePath, "utf8");
        dayFile = JSON.parse(raw);
        if (!dayFile || !Array.isArray(dayFile.entries)) {
          dayFile = { version: 1, date: dateStr, entries: [] };
        }
      } catch {
        dayFile = { version: 1, date: dateStr, entries: [] };
      }
    } else {
      dayFile = { version: 1, date: dateStr, entries: [] };
    }

    dayFile.entries.push(entry);

    if (dayFile.entries.length > DAY_FILE_CAP) {
      dayFile.entries = dayFile.entries.slice(-DAY_FILE_CAP);
    }

    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(dayFile, null, 2), "utf8");
    await rename(tmpPath, filePath);
  } catch (e) {
    console.error("[omp-permission-log] failed to log match outcome:", e);
  }
}

export default function hook(pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    try {
      const command = (event.input.command as string) || "";
      const cwd = ctx.cwd || process.cwd();
      const { rules, mode } = loadOmpPatternsAndMode(cwd);

      const { decision, pattern } = evaluateCommandDecision(command, rules, mode);

      let sessionID = "unknown";
      try {
        sessionID = ctx.sessionManager.getSessionId() || "unknown";
      } catch {}

      const entry: OmpSidecarEntry = {
        timestamp: new Date().toISOString(),
        sessionID,
        command,
        pattern,
        decision,
      };

      await logMatchOutcome(homedir(), entry);
    } catch (e) {
      console.error("[omp-permission-log] hook error:", e);
    }
  });
}
