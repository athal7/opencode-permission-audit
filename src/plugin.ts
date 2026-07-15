import type { Plugin } from "@opencode-ai/plugin";
import type { Event, Permission } from "@opencode-ai/sdk";
import { createBoundedCache, narrowResponse, shapeEntry, recordReply } from "./log-store.js";

const plugin: Plugin = async (_input) => {
  const pending = createBoundedCache<string, Permission>();

  return {
    event: async ({ event }: { event: Event }) => {
      switch (event.type) {
        case "permission.updated": {
          pending.set(event.properties.id, event.properties);
          return;
        }
        case "permission.replied": {
          const { permissionID, response } = event.properties;
          // A single "always" reply can trigger additional, independent
          // permission.replied events for other pending permission IDs in
          // the same session (opencode auto-resolves matching pending
          // prompts once a pattern is allowed). Each reply here does its
          // own take(permissionID) lookup keyed by the reply's own id, so
          // this cascade is handled correctly with no 1:1 ask/reply
          // pairing assumption — no extra logic is needed.
          const perm = pending.take(permissionID);
          if (!perm) return; // cache miss (no preceding permission.updated seen, or already consumed) — skip, fail open
          const resp = narrowResponse(response);
          if (!resp) return; // unrecognized response literal — skip
          const entry = shapeEntry(perm, resp, new Date().toISOString());
          await recordReply(entry, { onError: (e) => console.error("[opencode-permission-log]", e) });
          return;
        }
        default:
          return;
      }
    },
  };
};

export default plugin;
