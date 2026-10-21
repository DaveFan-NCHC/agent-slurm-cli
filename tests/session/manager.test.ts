import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeSession, inspectSession, openSession } from "../../src/session/manager.js";
import { sessionPaths } from "../../src/session/paths.js";
import {
  closeServer, sessionConfig, sessionToken, writeSessionMetadata,
} from "../support/session.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function listenWorker(
  directory: string,
  initialState: "connecting" | "ready" = "ready",
): Promise<{ methods: string[] }> {
  const config = sessionConfig(directory);
  const methods: string[] = [];
  let state = initialState;
  const server = createServer((socket) => {
    socket.once("data", (chunk) => {
      const line = chunk.subarray(0, chunk.indexOf(0x0a)).toString("utf8");
      const request = JSON.parse(line) as { method: string };
      methods.push(request.method);
      if (request.method === "open") state = "ready";
      socket.end(`${JSON.stringify({
        ok: true,
        result: request.method === "close" ? { closed: true } : {
          state,
          created_at: "2026-10-21T00:00:00.000Z",
          last_activity_at: "2026-10-21T00:00:00.000Z",
          idle_expires_at: "2026-10-21T00:30:00.000Z",
          max_expires_at: "2026-10-21T08:00:00.000Z",
          command_connection: state === "ready" ? "ready" : "disconnected",
          transfer_connection: "shared",
        },
      })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(sessionPaths(config).socket, resolve));
  writeSessionMetadata(config);
  return { methods };
}

describe("persistent session manager", () => {
  it("reuses, inspects, and closes a ready worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-session-manager-"));
    roots.push(root);
    const config = sessionConfig(root);
    const worker = await listenWorker(root);
    await expect(openSession(config, "/unused.js")).resolves.toMatchObject({ state: "ready", reused: true });
    await expect(inspectSession(config)).resolves.toMatchObject({ state: "ready" });
    await expect(closeSession(config)).resolves.toEqual({ closed: true, state: "closed" });
    expect(worker.methods).toEqual(["ping", "ping", "close"]);
  });

  it("waits for a worker that is still connecting", async () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-session-connecting-"));
    roots.push(root);
    const config = sessionConfig(root);
    const worker = await listenWorker(root, "connecting");
    await expect(openSession(config, "/unused.js")).resolves.toMatchObject({ state: "ready", reused: true });
    expect(worker.methods).toEqual(["ping", "open"]);
  });

  it("starts a new worker through the injected process boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-session-start-"));
    roots.push(root);
    const config = sessionConfig(root);
    let workerEnvironment: NodeJS.ProcessEnv | undefined;
    let workerPromise: Promise<{ methods: string[] }> | undefined;
    const result = await openSession(config, "/cli.js", {}, {
      startWorker: (_path, environment) => {
        workerEnvironment = environment;
        workerPromise = listenWorker(root, "connecting");
      },
    });
    expect(result).toMatchObject({ state: "ready", reused: false });
    expect(workerEnvironment?.SLURM_AGENT_INTERNAL_SESSION_WORKER).toBe("1");
    expect((await workerPromise)?.methods).toEqual(["open"]);
  });

  it("fails quickly when a worker never publishes metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-session-start-fail-"));
    roots.push(root);
    const config = sessionConfig(root);
    let clock = 0;
    await expect(openSession(config, "/cli.js", {}, {
      startWorker: () => {},
      delay: async () => { clock += 1000; },
      now: () => clock,
    })).rejects.toMatchObject({ code: "SESSION_LOST" });
  });

  it("removes stale metadata and reports no active session", async () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-session-stale-"));
    roots.push(root);
    const config = sessionConfig(root);
    writeSessionMetadata(config, sessionToken);
    await expect(inspectSession(config)).resolves.toEqual({ state: "not_open" });
    expect(existsSync(sessionPaths(config).metadata)).toBe(false);
    await expect(closeSession(config)).resolves.toEqual({ closed: false, state: "not_open" });
  });
});
