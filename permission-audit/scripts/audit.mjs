#!/usr/bin/env node
// Zero-dependency, standalone reporting tool for the opencode-permission-log
// sidecar files. Deliberately has no import from ../../src — this script
// gets copied on its own into other repos as part of the permission-audit
// Agent Skill, so it must not depend on the npm package's source tree.
//
// Detection-only: this script never writes to any opencode.json. It only
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
    "Usage: audit.mjs [--project <dir>] [--sidecar <dir>]",
    "",
    "  --project <dir>  Project directory to read opencode.json from (default: cwd)",
    "  --sidecar <dir>  Sidecar directory containing day-file JSONs",
    `                   (default: ${DEFAULT_SIDECAR_DIR})`,
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { project: process.cwd(), sidecar: DEFAULT_SIDECAR_DIR };
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
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
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
 *
 * This is a deliberate approximation of opencode's real permission
 * resolution (documented in the report's `notes`): exact match wins, then
 * the most specific glob match (longest key), then a `"*"` fallback, then
 * "unset" if the type has no entry at all.
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
      // Both are the pattern-map object form — merge keys, project wins on collision.
      merged[type] = { ...globalEntry, ...projectEntry };
    } else {
      // Mismatched shapes (string vs object) or both strings — project wins outright.
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
 * Aggregates all sidecar entries by (permission, pattern). An entry with
 * multiple patterns contributes to each pattern's aggregate independently.
 * Entries with no pattern (an empty `patterns` array) aggregate under the
 * empty-string pattern, representing "applies broadly, no specific pattern".
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

    // Policy-concern / ambiguous classification short-circuits: an aggregate
    // can appear in at most one category when it trips this heuristic.
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

    // Independent checks below: a single aggregate can land in more than
    // one of loosening/denials/friction if its history contains a mix of
    // always/reject/once replies over time.
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

function buildReport(args) {
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

main();
