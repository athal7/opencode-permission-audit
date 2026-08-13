#!/usr/bin/env node
// Zero-dependency, standalone reporting tool for the opencode-permission-log
// sidecar files and oh-my-pi/pi-coding-agent (omp) config & sidecar files.
// Deliberately has no import from ../../src — this script gets copied on its
// own into other repos as part of the permission-audit Agent Skill, so it
// must not depend on the npm package's source tree.
//
// Detection-only: this script never writes to any configuration files. It only
// reads sidecar day files and config files, and prints a JSON report.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_SIDECAR_DIR = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "storage",
  "plugin",
  "opencode-permission-log"
);

const DEFAULT_OMP_SIDECAR_DIR = join(
  homedir(),
  ".local",
  "share",
  "omp",
  "storage",
  "plugin",
  "omp-permission-log"
);

// opencode's own core tool permissions — already well-understood, so the
// write-verb heuristic below is only meant to flag *custom*/MCP tool names,
// not these.
const BUILTIN_PERMISSION_TYPES = new Set([
  "bash",
  "edit",
  "webfetch",
  "external_directory",
  "read",
  "write",
  "patch",
  "glob",
  "grep",
  "list",
  "todowrite",
  "todoread",
  "task",
  "skill",
  "lsp",
  "websearch",
]);

const WRITE_VERB_PATTERN = /(write|create|delete|update|post|put|patch|remove|send|push|merge|destroy|upload|add|insert|set)/i;

const FRICTION_THRESHOLD = 3;

function usage() {
  return [
    "Usage: audit.mjs [--project <dir>] [--sidecar <dir>] [--omp]",
    "",
    "  --project <dir>  Project directory to read config from (default: cwd)",
    "  --sidecar <dir>  Sidecar directory containing day-file JSONs",
    `                   (default: ${DEFAULT_SIDECAR_DIR} or ${DEFAULT_OMP_SIDECAR_DIR} if --omp is set)`,
    "  --omp            Run in oh-my-pi (omp) mode with bash pattern approval lists",
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { project: process.cwd(), sidecar: null, omp: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--project requires a value");
      args.project = value;
    } else if (arg === "--sidecar") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--sidecar requires a value");
      args.sidecar = value;
    } else if (arg === "--omp") {
      args.omp = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.sidecar === null) {
    args.sidecar = args.omp ? DEFAULT_OMP_SIDECAR_DIR : DEFAULT_SIDECAR_DIR;
  }
  return args;
}

/** Converts a simplified glob (only `*` is special) into an anchored RegExp. */
function globToRegex(glob) {
  const escaped = glob.replace(/([.+^${}()|[\]\\])/g, "\\$1");
  const pattern = escaped.split("*").join(".*");
  return new RegExp(`^${pattern}$`);
}

/**
 * Resolves the effective verdict for a (type, pattern) pair against a
 * merged permission config block.
 */
function resolveVerdict(mergedPermission, type, pattern) {
  const entry = mergedPermission[type];
  if (entry === undefined) return "unset";
  if (typeof entry === "string") return entry;

  if (Object.prototype.hasOwnProperty.call(entry, pattern)) {
    return entry[pattern];
  }

  const globMatches = Object.keys(entry)
    .filter((key) => key !== "*")
    .filter((key) => globToRegex(key).test(pattern));

  if (globMatches.length > 0) {
    globMatches.sort((a, b) => b.length - a.length);
    return entry[globMatches[0]];
  }

  if (Object.prototype.hasOwnProperty.call(entry, "*")) {
    return entry["*"];
  }

  return "unset";
}

/** Merges two `.permission` blocks; project's entries win over global's for the same type. */
function mergePermission(globalPermission, projectPermission) {
  const merged = {};
  const types = new Set([...Object.keys(globalPermission), ...Object.keys(projectPermission)]);
  for (const type of types) {
    const globalEntry = globalPermission[type];
    const projectEntry = projectPermission[type];
    if (projectEntry === undefined) {
      merged[type] = globalEntry;
    } else if (globalEntry === undefined) {
      merged[type] = projectEntry;
    } else if (isPlainObject(globalEntry) && isPlainObject(projectEntry)) {
      merged[type] = { ...globalEntry, ...projectEntry };
    } else {
      merged[type] = projectEntry;
    }
  }
  return merged;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadPermissionBlock(path) {
  try {
    const config = readJson(path);
    return config && isPlainObject(config.permission) ? config.permission : {};
  } catch {
    return {};
  }
}

/** Loads all readable day files from the sidecar directory. Malformed files are skipped, not thrown. */
function loadDayFiles(sidecarDir, notes) {
  let filenames;
  try {
    filenames = readdirSync(sidecarDir).filter((name) => name.endsWith(".json"));
  } catch (e) {
    notes.push(`sidecar directory unreadable, treating as empty: ${sidecarDir} (${e.message})`);
    return [];
  }

  const dayFiles = [];
  const skipped = [];
  for (const filename of filenames) {
    const path = join(sidecarDir, filename);
    try {
      const parsed = readJson(path);
      if (Array.isArray(parsed)) {
        dayFiles.push({ date: filename.replace(/\.json$/, ""), entries: parsed });
      } else if (parsed && Array.isArray(parsed.entries)) {
        dayFiles.push({ date: parsed.date ?? filename.replace(/\.json$/, ""), entries: parsed.entries });
      } else {
        throw new Error("unrecognized day file shape");
      }
    } catch {
      skipped.push(filename);
    }
  }
  if (skipped.length > 0) {
    notes.push(`skipped ${skipped.length} unreadable/malformed sidecar file(s): ${skipped.join(", ")}`);
  }
  return dayFiles;
}

/**
 * Aggregates all sidecar entries by (permission, pattern).
 */
function aggregateEntries(dayFiles) {
  const aggregates = new Map();
  let entriesScanned = 0;

  for (const dayFile of dayFiles) {
    for (const entry of dayFile.entries) {
      entriesScanned++;
      const patterns = entry.patterns && entry.patterns.length > 0 ? entry.patterns : [""];
      for (const pattern of patterns) {
        const key = `${entry.permission}\u0000${pattern}`;
        let aggregate = aggregates.get(key);
        if (!aggregate) {
          aggregate = {
            permission: entry.permission,
            pattern,
            counts: { once: 0, always: 0, reject: 0 },
            occurrences: 0,
            lastSeen: entry.timestamp,
          };
          aggregates.set(key, aggregate);
        }
        if (aggregate.counts[entry.response] !== undefined) {
          aggregate.counts[entry.response]++;
        }
        aggregate.occurrences++;
        if (entry.timestamp > aggregate.lastSeen) aggregate.lastSeen = entry.timestamp;
      }
    }
  }

  return { aggregates: [...aggregates.values()], entriesScanned };
}

/** null (builtin, not flagged) | "policyConcerns" | "ambiguous" */
function classifyPermissionType(type) {
  if (BUILTIN_PERMISSION_TYPES.has(type)) return null;
  return WRITE_VERB_PATTERN.test(type) ? "policyConcerns" : "ambiguous";
}

function classifyAggregates(aggregates, mergedPermission, configSources) {
  const loosening = [];
  const denials = [];
  const friction = [];
  const policyConcerns = [];
  const ambiguous = [];

  for (const aggregate of aggregates) {
    const { permission: type, pattern, counts, lastSeen } = aggregate;
    const flagged = classifyPermissionType(type);
    const hasAlwaysOrReject = counts.always > 0 || counts.reject > 0;

    if (flagged && hasAlwaysOrReject) {
      const response = counts.always > 0 ? "always" : "reject";
      const target = flagged === "policyConcerns" ? policyConcerns : ambiguous;
      const reason =
        flagged === "policyConcerns"
          ? "permission key name suggests a write-capable remote/MCP tool; write approval is generally meant to stay required"
          : "non-builtin permission key with unclear write semantics; confirm with a human before treating as loosening-safe";
      target.push({
        permission: type,
        pattern,
        ...(flagged === "policyConcerns" ? { response } : {}),
        occurrences: counts[response],
        reason,
      });
      continue;
    }

    if (counts.always > 0) {
      const currentVerdict = resolveVerdict(mergedPermission, type, pattern);
      if (currentVerdict !== "allow") {
        const usesStringForm = typeof mergedPermission[type] === "string" || mergedPermission[type] === undefined;
        loosening.push({
          permission: type,
          pattern,
          occurrences: counts.always,
          currentVerdict,
          suggestedChange: {
            file: configSources.project ?? configSources.global,
            key: usesStringForm ? `permission.${type}` : `permission.${type}.${pattern}`,
            from: currentVerdict,
            to: "allow",
          },
        });
      }
    }

    if (counts.reject > 0) {
      denials.push({ permission: type, pattern, occurrences: counts.reject, lastSeen });
    }

    if (counts.once >= FRICTION_THRESHOLD) {
      friction.push({ permission: type, pattern, occurrences: counts.once });
    }
  }

  return { loosening, denials, friction, policyConcerns, ambiguous };
}

// =================================═══════════════════════════════════════════
// OMP Mode Support
// =================================═══════════════════════════════════════════

export function parseSimpleYaml(content) {
  const lines = content.split(/\r?\n/);
  let currentKey = null;
  let inBashPatterns = false;
  let currentPatternRule = null;
  const bashPatterns = [];
  let approvalMode = null;

  for (let line of lines) {
    const hashIdx = line.indexOf("#");
    if (hashIdx !== -1) {
      line = line.slice(0, hashIdx);
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const indent = line.length - line.trimStart().length;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx !== -1) {
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();

      if (key === "bash.patterns" || (key === "patterns" && currentKey === "bash")) {
        inBashPatterns = true;
        continue;
      } else if (key === "tools.approvalMode" || (key === "approvalMode" && currentKey === "tools")) {
        approvalMode = val.replace(/['"]/g, "").trim();
        inBashPatterns = false;
        continue;
      }

      if (indent === 0) {
        currentKey = key;
        inBashPatterns = false;
      }
    }

    if (inBashPatterns) {
      if (trimmed.startsWith("-")) {
        if (currentPatternRule) {
          bashPatterns.push(currentPatternRule);
        }
        currentPatternRule = {};
        const rest = trimmed.slice(1).trim();
        const cIdx = rest.indexOf(":");
        if (cIdx !== -1) {
          const k = rest.slice(0, cIdx).trim();
          const v = rest.slice(cIdx + 1).trim().replace(/['"]/g, "");
          currentPatternRule[k] = v;
        }
      } else {
        const cIdx = trimmed.indexOf(":");
        if (cIdx !== -1 && currentPatternRule) {
          const k = trimmed.slice(0, cIdx).trim();
          const v = trimmed.slice(cIdx + 1).trim().replace(/['"]/g, "");
          currentPatternRule[k] = v;
        }
      }
    }
  }

  if (currentPatternRule) {
    bashPatterns.push(currentPatternRule);
  }

  return {
    "bash.patterns": bashPatterns,
    "tools.approvalMode": approvalMode
  };
}

function loadOmpConfig(projectDir) {
  const projectPaths = [
    join(projectDir, ".omp", "config.yml"),
    join(projectDir, ".omp", "config.yaml"),
  ];
  const globalPaths = [
    join(homedir(), ".omp", "agent", "config.yml"),
    join(homedir(), ".omp", "agent", "config.yaml"),
    join(homedir(), ".omp", "config.yml"),
    join(homedir(), ".omp", "config.yaml"),
  ];

  let projectPath = null;
  let projectContent = null;
  for (const path of projectPaths) {
    if (existsSync(path)) {
      projectPath = path;
      try {
        projectContent = readFileSync(path, "utf8");
      } catch {}
      break;
    }
  }

  let globalPath = null;
  let globalContent = null;
  for (const path of globalPaths) {
    if (existsSync(path)) {
      globalPath = path;
      try {
        globalContent = readFileSync(path, "utf8");
      } catch {}
      break;
    }
  }

  return {
    projectPath,
    projectContent,
    globalPath,
    globalContent,
  };
}

function buildOmpReport(args) {
  const notes = [
    "config merge is an approximation of omp's real resolution logic",
    "glob matching is simplified (basic * wildcard only)",
  ];

  const configInfo = loadOmpConfig(args.project);

  const configSources = {
    global: configInfo.globalPath,
    project: configInfo.projectPath,
  };

  const parsedGlobal = configInfo.globalContent ? parseSimpleYaml(configInfo.globalContent) : { "bash.patterns": [], "tools.approvalMode": null };
  const parsedProject = configInfo.projectContent ? parseSimpleYaml(configInfo.projectContent) : { "bash.patterns": [], "tools.approvalMode": null };

  const approvalMode = parsedProject["tools.approvalMode"] || parsedGlobal["tools.approvalMode"] || "yolo";
  const mergedPatterns = [...(parsedProject["bash.patterns"] || []), ...(parsedGlobal["bash.patterns"] || [])];

  const sidecarDir = resolve(args.sidecar);
  const dayFiles = loadDayFiles(sidecarDir, notes);

  // Aggregate OMP logs
  const aggregates = new Map();
  let entriesScanned = 0;

  for (const dayFile of dayFiles) {
    for (const entry of dayFile.entries) {
      entriesScanned++;
      const patternKey = entry.pattern || ""; // empty string if none matched
      const key = `${patternKey}\u0000${entry.decision}`;
      let aggregate = aggregates.get(key);
      if (!aggregate) {
        aggregate = {
          pattern: entry.pattern,
          decision: entry.decision,
          occurrences: 0,
          commands: new Set(),
          lastSeen: entry.timestamp,
        };
        aggregates.set(key, aggregate);
      }
      aggregate.occurrences++;
      if (entry.command) {
        aggregate.commands.add(entry.command);
      }
      if (entry.timestamp > aggregate.lastSeen) {
        aggregate.lastSeen = entry.timestamp;
      }
    }
  }

  const listAggregates = [...aggregates.values()];

  const friction = [];
  const denials = [];
  const active = [];

  for (const agg of listAggregates) {
    const item = {
      pattern: agg.pattern || "(none)",
      occurrences: agg.occurrences,
      lastSeen: agg.lastSeen,
      commands: [...agg.commands],
    };

    if (agg.decision === "deny") {
      denials.push(item);
    } else if (agg.decision === "prompt") {
      friction.push(item);
    } else if (agg.decision === "allow") {
      active.push(item);
    }
  }

  // Find dead config patterns
  const matchedPatterns = new Set(listAggregates.map(a => a.pattern).filter(Boolean));
  const deadConfig = [];
  for (const rule of mergedPatterns) {
    if (!matchedPatterns.has(rule.match)) {
      deadConfig.push({
        pattern: rule.match,
        approval: rule.approval,
      });
    }
  }

  const dates = dayFiles.map((d) => d.date).sort();
  const dateRange = dates.length > 0 ? [dates[0], dates[dates.length - 1]] : ["", ""];

  return {
    generatedAt: new Date().toISOString(),
    sidecarDir,
    configSources,
    totals: { entriesScanned, days: dayFiles.length, dateRange },
    friction,
    deadConfig,
    denials,
    active,
    notes,
  };
}

// =================================═══════════════════════════════════════════
// Core Orchestration
// =================================═══════════════════════════════════════════

function buildReport(args) {
  if (args.omp) {
    return buildOmpReport(args);
  }

  const notes = [
    "config merge is an approximation of opencode's real resolution logic",
    "glob matching is simplified (basic * wildcard only)",
  ];

  const projectConfigPath = join(args.project, "opencode.json");
  const globalConfigPath = join(homedir(), ".config", "opencode", "opencode.json");
  const projectExists = existsSync(projectConfigPath);
  const globalExists = existsSync(globalConfigPath);

  const configSources = {
    global: globalExists ? globalConfigPath : null,
    project: projectExists ? projectConfigPath : null,
  };

  const globalPermission = globalExists ? loadPermissionBlock(globalConfigPath) : {};
  const projectPermission = projectExists ? loadPermissionBlock(projectConfigPath) : {};
  const mergedPermission = mergePermission(globalPermission, projectPermission);

  const sidecarDir = resolve(args.sidecar);
  const dayFiles = loadDayFiles(sidecarDir, notes);
  const { aggregates, entriesScanned } = aggregateEntries(dayFiles);
  const { loosening, denials, friction, policyConcerns, ambiguous } = classifyAggregates(
    aggregates,
    mergedPermission,
    configSources
  );

  const dates = dayFiles.map((d) => d.date).sort();
  const dateRange = dates.length > 0 ? [dates[0], dates[dates.length - 1]] : ["", ""];

  return {
    generatedAt: new Date().toISOString(),
    sidecarDir,
    configSources,
    totals: { entriesScanned, days: dayFiles.length, dateRange },
    loosening,
    denials,
    friction,
    policyConcerns,
    ambiguous,
    notes,
  };
}

import { fileURLToPath } from "node:url";

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${usage()}`);
    process.exit(1);
  }

  let report;
  try {
    report = buildReport(args);
  } catch (e) {
    // This is a read-only reporting tool: an internal error should surface
    // via `notes` in still-valid JSON, not a crash or nonzero exit.
    report = {
      generatedAt: new Date().toISOString(),
      sidecarDir: resolve(args.sidecar),
      configSources: { global: null, project: null },
      totals: { entriesScanned: 0, days: 0, dateRange: ["", ""] },
      loosening: [],
      denials: [],
      friction: [],
      policyConcerns: [],
      ambiguous: [],
      notes: [`internal error while building report: ${e.message}`],
    };
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main();
}
