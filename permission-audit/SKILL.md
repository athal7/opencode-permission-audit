---
name: permission-audit
description: "Audit opencode and omp permission logs — surface loosening candidates, denials, friction signals, and dead configurations against current project configurations. Use when tuning permissions or investigating repeated prompts."
license: MIT
---

# permission-audit

This skill supports auditing both **opencode** (via `opencode-permission-log` plugin) and **omp** (@oh-my-pi/pi-coding-agent, via `omp-permission-log` hook). It reads sidecar files, compares them against the project's actual configurations, and reports where the config is out of step with observed reality.

## Running the audit

Resolve `<skill-dir>` as the directory containing this `SKILL.md` file, then run:

### For opencode:

```
node <skill-dir>/scripts/audit.mjs --project "$PWD"
```

The script also accepts `--sidecar <dir>` to point at a non-default sidecar location (default is `~/.local/share/opencode/storage/plugin/opencode-permission-log/`).

### For omp (@oh-my-pi/pi-coding-agent):

```
node <skill-dir>/scripts/audit.mjs --project "$PWD" --omp
```

The script also accepts `--sidecar <dir>` to point at a non-default sidecar location (default is `~/.local/share/omp/storage/plugin/omp-permission-log/`).

The script always exits `0` and prints exactly one JSON object to stdout. Internal errors are reported inside the JSON's `notes` array, not as a crash or a nonzero exit.

## Presenting results (opencode Mode)

Turn the JSON into a short markdown report for the human, with these sections, in this order:

1. **Loosening candidates** — from `loosening[]`. One line per item: the exact permission + pattern, the occurrence count, and the exact `suggestedChange.file` / `key` / `from` → `to` the human could apply by hand.
2. **Denials** — from `denials[]`. One line per item: permission + pattern, occurrence count, last-seen timestamp.
3. **Friction** — from `friction[]`. One line per item: permission + pattern, occurrence count (repeated `once` replies).
4. **Policy concerns** — from `policyConcerns[]`, and a follow-up **Ambiguous** subsection from `ambiguous[]`.

Never auto-suggest loosening a policy concern — flag permission keys that look write-capable (custom tools, MCP servers) or whose write semantics are unclear.

## Presenting results (omp Mode)

Turn the JSON into a short markdown report for the human, with these sections, in this order:

1. **Friction** — from `friction[]`. List of patterns/commands that are causing prompt friction. Suggest adding an `allow` rule for these commands in `config.yml`.
2. **Dead config** — from `deadConfig[]`. List of patterns in your configuration that have never matched and are candidates for removal.
3. **Denials** — from `denials[]`. List of pattern-matches or commands blocked by your `deny` rules.
4. **Active patterns** — from `active[]`. Frequently matched allowed patterns, showing observed usage.

## Detection-only — hard constraint

This skill must never write to any configuration file (`opencode.json` or `.omp/config.yml`), and must never apply a diff or patch to any config file. Its only output is the report described above.
