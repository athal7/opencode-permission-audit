# opencode-permission-audit

opencode shows an interactive permission prompt every time a tool call
needs your approval, and asks you to reply `once`, `always`, or `reject`.
That reply is a real signal about what your checked-in permission config
*should* say — this repo captures that signal (via a plugin) and turns it
into actionable audit output (via an Agent Skill), so static permission
config can be tuned from real usage instead of re-approving the same
pattern every session.

This repository also supports **omp** (`@oh-my-pi/pi-coding-agent`), capturing
its observed pattern-match decisions via an agent hook and running the same
kind of "config vs. observed reality" audit against its bash-pattern approval list.

It contains three deliverables:

- **`opencode-permission-log`** — an npm plugin that logs every opencode permission
  reply to a local JSON sidecar file.
- **`omp-permission-log.ts`** — an omp hook that intercepts bash tool calls, evaluates
  them against your `bash.patterns`, and logs decisions (allow, prompt, deny) to sidecar files.
- **`permission-audit`** — an Agent Skill that reads those sidecar files (for either opencode or omp)
  and reports loosening candidates, denials, friction, and dead configurations.

## Plugin: `opencode-permission-log`

### What it does

Hooks into opencode's generic `event` hook and listens for
`permission.updated` (a permission prompt was shown) followed by
`permission.replied` (the human responded). When a reply is `once`,
`always`, or `reject`, it appends a small JSON record to a per-day sidecar
file under your local opencode storage directory. It never blocks or
crashes the permission flow — all file IO is fail-open: any IO error is
swallowed and reported to `console.error`, never thrown back into
opencode's event loop.

### Install

Add it to opencode's plugin list, either globally (all projects) in
`~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["opencode-permission-log"]
}
```

or scoped to a single project in that project's `./opencode.json`.

### Sidecar files

Entries are written to:

```
~/.local/share/opencode/storage/plugin/opencode-permission-log/<YYYY-MM-DD>.json
```

## Omp Hook: `omp-permission-log.ts`

### What it does

Hooks into `omp`'s event/hook subsystem. On `tool_call` of the `bash` tool, it loads your project and global `.omp/config.yml` settings, parses `bash.patterns` and `tools.approvalMode`, evaluates the command (re-deriving the exact decision of allow/prompt/deny), and logs outcomes to daily JSON sidecars.

### Install

Run `omp` specifying the hook file:

```bash
omp --hook omp-permission-log.ts
```

Or copy the hook to your local hooks directory for auto-discovery:

```bash
cp omp-permission-log.ts ~/.omp/agent/hooks/
```

### Sidecar files

Entries are written to:

```
~/.local/share/omp/storage/plugin/omp-permission-log/<YYYY-MM-DD>.json
```

Each file is an `OmpDayFile`:

```ts
interface OmpDayFile {
  version: 1;
  date: string;          // "YYYY-MM-DD" (UTC)
  entries: OmpSidecarEntry[];
}

interface OmpSidecarEntry {
  timestamp: string;     // ISO 8601
  sessionID: string;
  command: string;       // Executed command
  pattern: string | null;// Matched pattern rule, or null if none
  decision: "allow" | "prompt" | "deny";
}
```

## Skill: `permission-audit`

### What it does

Reads the sidecar files and current configuration files, then reports actionable tuning recommendations.

- In **opencode mode**, it reports loosening candidates, denials, and friction.
- In **omp mode**, it reports friction (patterns frequently prompting), dead configuration (configured rules that have never matched and are candidates for removal), denials, and active patterns.

### Usage

#### For opencode:

```bash
node permission-audit/scripts/audit.mjs --project "$PWD"
```

#### For omp:

```bash
node permission-audit/scripts/audit.mjs --project "$PWD" --omp
```

See `permission-audit/SKILL.md` for the full workflow and instructions.

## Credit

The Agent Skill format used by `permission-audit/SKILL.md` was originally
developed by Anthropic and released as an open standard. See the
[agentskills.io specification](https://agentskills.io/specification).

## License

MIT — see [LICENSE](./LICENSE).

## Development

```bash
npm install && npm test && npm run build
```
