---
name: permission-audit
description: Audit opencode permission-prompt replies logged by the opencode-permission-log plugin — surface loosening candidates, denials, and friction signals against the current project's effective permission config. Detection-only: reports exact config file/key to change, never edits config itself. Use when tuning opencode's permission config or investigating repeated approval prompts.
license: MIT
---

# permission-audit

opencode's permission system prompts a human every time a tool call needs
approval, and each reply (`once`, `always`, or `reject`) is a real signal
about what the static permission config *should* say. The
`opencode-permission-log` plugin captures those replies into per-day JSON
sidecar files; this skill reads those sidecar files, compares them against
the project's actual permission config, and reports where the config is
out of step with how a human has actually been responding.

## Running the audit

Resolve `<skill-dir>` as the directory containing this `SKILL.md` file, then run:

```
node <skill-dir>/scripts/audit.mjs --project "$PWD"
```

The script also accepts `--sidecar <dir>` to point at a non-default
sidecar location (default is
`~/.local/share/opencode/storage/plugin/opencode-permission-log/`).

The script always exits `0` and prints exactly one JSON object to stdout
(pretty-printed). Parse that JSON object — it is the entire output of the
tool. Internal errors (a missing sidecar dir, an unreadable config file,
one malformed day file, etc.) are reported inside the JSON's `notes` array,
not as a crash or a nonzero exit — this is intentionally a read-only
reporting tool that degrades gracefully rather than failing loudly.

## Presenting results

Turn the JSON into a short markdown report for the human, with these four
sections, in this order:

1. **Loosening candidates** — from `loosening[]`. One line per item:
   the exact permission + pattern, the occurrence count, and the exact
   `suggestedChange.file` / `key` / `from` → `to` the human could apply by
   hand.
2. **Denials** — from `denials[]`. One line per item: permission +
   pattern, occurrence count, last-seen timestamp.
3. **Friction** — from `friction[]`. One line per item: permission +
   pattern, occurrence count (repeated `once` replies — a candidate for
   *some* config change, though not necessarily `allow`).
4. **Policy concerns** — from `policyConcerns[]`, and a follow-up
   **Ambiguous** subsection from `ambiguous[]`.

For every item in `policyConcerns` and `ambiguous`, explicitly ask the
human to confirm before suggesting any change. Never auto-suggest loosening
a policy concern — these two arrays exist specifically to flag permission
keys that *look* write-capable (custom tools, MCP servers) or whose write
semantics are unclear, where a false "safe to loosen" recommendation would
be actively harmful.

## Detection-only — hard constraint

This skill must never write to any `opencode.json`, and must never apply a
diff or patch to any config file. Its only output is the report described
above. If the human decides to act on a suggestion, they (or a separate,
explicitly-invoked tool) make that edit — this skill's job ends at
reporting the exact file/key/from/to.

## Relationship to opencode-permission-log

This skill has **no code dependency** on the `opencode-permission-log` npm
package — `scripts/audit.mjs` is a standalone, zero-dependency Node ESM
script that only reads the JSON sidecar files that plugin produces. You can
copy this `permission-audit/` directory into any project's skill directory
on its own; it does not require `opencode-permission-log` to be installed
as an npm dependency of that project, only that the plugin (installed
separately, in whichever project generates the sidecar data) has been
writing to the sidecar location this script reads from.
