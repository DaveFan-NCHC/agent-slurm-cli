import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PreferredRemoteExecutor, requestSession, SessionRemoteExecutor,
} from "../../src/session/client.js";
import { MockRemoteExecutor, ok } from "../support/slurm.js";
import { closeServer, sessionConfig, sessionToken } from "../support/session.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function serverFor(response: string | "close" | "timeout"): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "slurm-agent-session-protocol-"));
  roots.push(root);
  const socketPath = join(root, "server.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      if (response === "close") socket.destroy();
      else if (response !== "timeout") socket.end(response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return socketPath;
}

describe("session RPC client failures", () => {
  it("preserves structured worker errors", async () => {
    const socket = await serverFor(`${JSON.stringify({
      ok: false,
      error: { code: "SESSION_PROTOCOL_ERROR", message: "denied", exitCode: 4, details: { field: "token" } },
    })}\n`);
    await expect(requestSession(socket, sessionToken, { method: "ping" })).rejects.toMatchObject({
      code: "SESSION_PROTOCOL_ERROR", message: "denied", exitCode: 4, details: { field: "token" },
    });
  });

  it.each([
    ["invalid JSON", "not-json\n", "SESSION_PROTOCOL_ERROR"],
    ["an early close", "close", "SESSION_LOST"],
    ["a timeout", "timeout", "SESSION_LOST"],
  ] as const)("rejects %s", async (_name, response, code) => {
    const socket = await serverFor(response);
    await expect(requestSession(socket, sessionToken, { method: "ping" }, undefined, 20))
      .rejects.toMatchObject({ code });
  });

  it("forwards every executor operation through RPC", async () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-session-methods-"));
    roots.push(root);
    const socketPath = join(root, "server.sock");
    const methods: string[] = [];
    const server = createServer((socket) => {
      socket.once("data", (chunk) => {
        const header = JSON.parse(chunk.subarray(0, chunk.indexOf(0x0a)).toString("utf8")) as { method: string };
        methods.push(header.method);
        socket.end(`${JSON.stringify({ ok: true, result: { bytes: 1 } })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const executor = new SessionRemoteExecutor(socketPath, sessionToken, 1000);
    await executor.downloadArtifact({ remotePath: "/work/a", localPath: "/tmp/a", maxBytes: 1 });
    await executor.downloadArtifactBundle({
      remoteDirectory: "/work/a", remoteArchivePath: "/work/a.tgz", localPath: "/tmp/a.tgz", maxBytes: 1,
    });
    await executor.close();
    expect(methods).toEqual(["downloadArtifact", "downloadArtifactBundle"]);
  });

  it("falls back once to a one-shot executor when no session is active", async () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-session-fallback-"));
    roots.push(root);
    const fallback = new MockRemoteExecutor([ok("fallback\n")]);
    let creations = 0;
    const executor = new PreferredRemoteExecutor(sessionConfig(root), () => {
      creations += 1;
      return fallback;
    });
    await expect(executor.run({ executable: "squeue", args: [] })).resolves.toMatchObject({ stdout: "fallback\n" });
    await executor.close();
    expect(creations).toBe(1);
  });
});
