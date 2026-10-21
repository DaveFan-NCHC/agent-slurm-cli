import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRemoteExecutor } from "../../src/session/client.js";
import { ensureSessionDirectory, readSessionMetadata, sessionPaths } from "../../src/session/paths.js";
import type { SshConfig } from "../../src/config/loader.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sshConfig(directory: string, host = "login.example"): SshConfig {
  return {
    host,
    port: 22,
    user: "alice",
    authentication: { type: "password", password: "not-part-of-session-key" },
    hostFingerprint: "SHA256:test",
    readyTimeoutMs: 30000,
    pushAuthentication: false,
    workspace: "/work",
    timeoutMs: 30000,
    sessionDirectory: directory,
    sessionIdleTimeoutMs: 1800000,
    sessionMaxLifetimeMs: 28800000,
  };
}

describe("persistent session paths", () => {
  it("derives one socket per connection identity without including the password", () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-session-path-"));
    roots.push(root);
    const first = sessionPaths(sshConfig(root));
    const changedPassword = sshConfig(root);
    changedPassword.authentication = { type: "password", password: "changed" };
    expect(sessionPaths(changedPassword).socket).toBe(first.socket);
    expect(sessionPaths(sshConfig(root, "other.example")).socket).not.toBe(first.socket);
  });

  it("requires owner-only session directory and metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-session-mode-"));
    roots.push(root);
    const directory = join(root, "runtime");
    mkdirSync(directory, { mode: 0o700 });
    ensureSessionDirectory(directory);
    const metadata = join(directory, "test.json");
    writeFileSync(metadata, JSON.stringify({
      version: 1, pid: process.pid, token: "a".repeat(64), createdAt: new Date().toISOString(),
    }), { mode: 0o600 });
    expect(readSessionMetadata(metadata)).toMatchObject({ version: 1, pid: process.pid });
  });
});

describe("persistent session transport", () => {
  it("forwards commands and upload bodies over the protected local socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-session-rpc-"));
    roots.push(root);
    const socketPath = join(root, "worker.sock");
    const requests: Array<{ method?: string; body: string }> = [];
    const server = createServer((socket) => {
      let buffered = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) return;
        const header = JSON.parse(buffered.subarray(0, newline).toString("utf8")) as {
          method?: string; bodyLength: number;
        };
        const body = buffered.subarray(newline + 1);
        if (body.length !== header.bodyLength) return;
        requests.push({ method: header.method, body: body.toString("utf8") });
        const result = header.method === "run"
          ? { stdout: "ok\n", stderr: "", exitCode: 0 }
          : { bytes: body.length };
        socket.end(`${JSON.stringify({ ok: true, result })}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const executor = new SessionRemoteExecutor(socketPath, "t".repeat(64), 3000);
      await expect(executor.run({ executable: "squeue", args: [] })).resolves.toMatchObject({
        stdout: "ok\n", exitCode: 0,
      });
      await expect(executor.uploadSubmission({
        content: Buffer.from("payload"), remotePath: "/work/payload", maxBytes: 64,
      })).resolves.toEqual({ bytes: 7 });
      expect(requests).toEqual([
        { method: "run", body: "" },
        { method: "uploadSubmission", body: "payload" },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
