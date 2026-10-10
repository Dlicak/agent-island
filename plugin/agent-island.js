import { connect } from "net";
import { tmpdir } from "os";
import { join } from "path";

const RUNTIME = process.env.XDG_RUNTIME_DIR || join(tmpdir());
const SOCKET = join(RUNTIME, "agent-island.sock");

function send(json) {
  return new Promise((resolve) => {
    try {
      const sock = connect({ path: SOCKET }, () => {
        sock.write(JSON.stringify(json));
        sock.end();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      sock.setTimeout(3000, () => { sock.destroy(); resolve(false); });
    } catch {
      resolve(false);
    }
  });
}

function sendAndWait(json, timeoutMs = 300000) {
  return new Promise((resolve) => {
    try {
      const sock = connect({ path: SOCKET }, () => {
        sock.write(JSON.stringify(json));
      });
      let buf = "";
      sock.on("data", (d) => { buf += d.toString(); });
      sock.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
      sock.on("error", () => resolve(null));
      sock.setTimeout(timeoutMs, () => { sock.destroy(); resolve(null); });
    } catch {
      resolve(null);
    }
  });
}

export default async ({ client, serverUrl }) => {
  const pid = process.pid;
  const serverPort = serverUrl ? parseInt(serverUrl.port) || 4096 : 4096;
  const internalFetch = client?._client?.getConfig?.()?.fetch || null;

  const sessions = new Map();

  function base(sessionId, extra) {
    return {
      session_id: sessionId,
      _source: "opencode",
      _ppid: pid,
      _server_port: serverPort,
      ...extra,
    };
  }

  function remember(sessionId, cwd) {
    if (!sessionId)
      return;
    sessions.set(sessionId, cwd || sessions.get(sessionId) || null);
  }

  const heartbeat = setInterval(() => {
    for (const [sid, cwd] of sessions)
      send(base(sid, { hook_event_name: "Heartbeat", cwd: cwd || undefined }));
  }, 10000);
  if (heartbeat.unref)
    heartbeat.unref();

  return {
    event: async ({ event }) => {
      const t = event.type;
      const p = event.properties || {};
      let mapped = null;

      if (t === "session.created" && p.info) {
        mapped = base(`opencode-${p.info.id}`, {
          hook_event_name: "SessionStart",
          cwd: p.info.directory,
        });
      } else if (t === "session.deleted" && p.info) {
        mapped = base(`opencode-${p.info.id}`, { hook_event_name: "SessionEnd" });
      } else if (t === "message.part.updated" && p.part?.type === "tool" && p.part?.sessionID) {
        const st = p.part.state?.status;
        const toolName =
          (p.part.tool || "").charAt(0).toUpperCase() + (p.part.tool || "").slice(1);
        if (st === "running" || st === "pending") {
          mapped = base(`opencode-${p.part.sessionID}`, {
            hook_event_name: "PreToolUse",
            tool_name: toolName,
          });
        } else if (st === "completed" || st === "error") {
          mapped = base(`opencode-${p.part.sessionID}`, {
            hook_event_name: "PostToolUse",
            tool_name: toolName,
          });
        }
      } else if (t === "permission.asked" && p.id && p.sessionID) {
        const toolName =
          (p.permission || "").charAt(0).toUpperCase() + (p.permission || "").slice(1);
        mapped = base(`opencode-${p.sessionID}`, {
          hook_event_name: "PermissionRequest",
          tool_name: toolName,
          tool_input: { patterns: p.patterns || [] },
          _opencode_request_id: p.id,
        });
        remember(mapped.session_id, null);

        if (internalFetch) {
          const resp = await sendAndWait(mapped);
          const behavior = resp?.hookSpecificOutput?.decision?.behavior;
          if (behavior) {
            const reply =
              behavior === "allow" ? "once" : behavior === "always" ? "always" : "reject";
            try {
              await internalFetch(
                new Request(`http://localhost:${serverPort}/permission/${p.id}/reply`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ reply }),
                })
              );
            } catch {}
          }
          return;
        }
      }

      if (mapped) {
        if (mapped.hook_event_name === "SessionEnd")
          sessions.delete(mapped.session_id);
        else
          remember(mapped.session_id, mapped.cwd);
        await send(mapped);
      }
    },
  };
};
