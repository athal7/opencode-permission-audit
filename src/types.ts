/** The three permission-reply literals opencode's TUI can send back. */
export type ReplyResponse = "once" | "always" | "reject";

/** One logged permission-prompt reply, as persisted in a day file. */
export interface SidecarEntry {
  /** ISO 8601 string, e.g. new Date().toISOString() — chosen for human-readability in a JSON audit log. */
  timestamp: string;
  sessionID: string;
  /** Permission.type, e.g. "bash". */
  permission: string;
  /** Normalized from Permission.pattern — never undefined, empty array if absent. */
  patterns: string[];
  response: ReplyResponse;
}

/** The on-disk shape of a single day's sidecar file. */
export interface DayFile {
  version: 1;
  /** "YYYY-MM-DD" (UTC). */
  date: string;
  entries: SidecarEntry[];
}
