import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestSession } from "../../src/session/client.js";
import { readSessionMetadata, sessionPaths } from "../../src/session/paths.js";
import {
  runSessionWorker, type SessionWorkerExecutor,
} from "../../src/session/worker.js";
import type {
  ArtifactDownload, RemoteResult, SafeArtifactBundleTransfer, SafeArtifactTransfer,
  SafeCommand, SafeSubmissionUpload,
} from "../../src/transport/types.js";
import { sessionConfig, waitFor } from "../support/session.js";

const roots: string[] = [];
let active: { socket: string; token: string } | undefined;

afterEach(async () => {
  if (active) {
    await requestSession(active.socket, active.token, { method: "close" }, undefined, 100).catch(() => undefined);
    active = undefined;
  }
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeSshExecutor implements SessionWorkerExecutor {
  connected = false;
  closed = false;
  reconnectPrevented = false;
  readonly events: string[] = [];
  readonly uploads: SafeSubmissionUpload[] = [];

  connectionStatus(): { command: boolean; transfer: boolean | "shared" } {
    return { command: this.connected, transfer: "shared" };
  }
  isConnected(): boolean { return this.connected; }
  async open(): Promise<void> { this.connected = true; }
  preventReconnect(): void { this.reconnectPrevented = true; }
  async run(command: SafeCommand): Promise<RemoteResult> {
    const label = command.args[0] ?? "command";
    this.events.push(`start:${label}`);
    if (label === "slow") await new Promise((resolve) => setTimeout(resolve, 20));
    this.events.push(`end:${label}`);
    return { stdout: `${label}\n`, stderr: "", exitCode: 0 };
  }
  async downloadArtifact(_transfer: SafeArtifactTransfer): Promise<ArtifactDownload> {
    return { bytes: 1, sha256: "a".repeat(64), overwritten: false };
  }
  async downloadArtifactBundle(_transfer: SafeArtifactBundleTransfer): Promise<ArtifactDownload> {
    return { bytes: 2, sha256: "b".repeat(64), overwritten: false };
  }
  async uploadSubmission(upload: SafeSubmissionUpload): Promise<{ bytes: number }> {
    this.uploads.push(upload);
    return { bytes: upload.content.length };
  }
  async close(): Promise<void> { this.connected = false; this.closed = true; }
}

function configureWorker(root: string): void {
  vi.stubEnv("SLURM_SSH_HOST", "login.example");
  vi.stubEnv("SLURM_SSH_USER", "alice");
  vi.stubEnv("SLURM_SSH_PASSWORD", "secret");
  vi.stubEnv("SLURM_SSH_HOST_FINGERPRINT", "SHA256:test");
  vi.stubEnv("SLURM_REMOTE_WORKSPACE", "/work");
  vi.stubEnv("SLURM_SSH_SESSION_DIR", root);
  vi.stubEnv("SLURM_SSH_SESSION_IDLE_TIMEOUT_MS", "60000");
  vi.stubEnv("SLURM_SSH_SESSION_MAX_LIFETIME_MS", "60000");
}

async function startWorker(): Promise<{ fake: FakeSshExecutor; socket: string; token: string }> {
  const root = mkdtempSync(join(tmpdir(), "slurm-agent-session-worker-"));
  roots.push(root);
  configureWorker(root);
  const fake = new FakeSshExecutor();
  await runSessionWorker({ createExecutor: () => fake });
  const paths = sessionPaths(sessionConfig(root));
  const metadata = readSessionMetadata(paths.metadata);
  if (!metadata) throw new Error("Worker did not publish metadata");
  active = { socket: paths.socket, token: metadata.token };
  return { fake, socket: paths.socket, token: metadata.token };
}

async function rawRequest(socketPath: string, payload: string): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.once("error", reject);
    socket.once("end", () => resolve(JSON.parse(response) as Record<string, unknown>));
  });
}

describe("persistent session worker", () => {
  it("authenticates, opens, serializes operations, transfers data, and shuts down", async () => {
    const { fake, socket, token } = await startWorker();
    await expect(requestSession(socket, "wrong-token", { method: "ping" }))
      .rejects.toMatchObject({ code: "SESSION_PROTOCOL_ERROR" });
    await expect(requestSession(socket, token, { method: "ping" })).resolves.toMatchObject({
      state: "connecting", command_connection: "disconnected",
    });
    await expect(requestSession(socket, token, { method: "open" })).resolves.toMatchObject({
      state: "ready", command_connection: "ready",
    });
    expect(fake.reconnectPrevented).toBe(true);

    const slow = requestSession(socket, token, {
      method: "run", command: { executable: "squeue", args: ["slow"] },
    });
    const fast = requestSession(socket, token, {
      method: "run", command: { executable: "squeue", args: ["fast"] },
    });
    await expect(Promise.all([slow, fast])).resolves.toEqual([
      { stdout: "slow\n", stderr: "", exitCode: 0 },
      { stdout: "fast\n", stderr: "", exitCode: 0 },
    ]);
    expect(fake.events).toEqual(["start:slow", "end:slow", "start:fast", "end:fast"]);

    await expect(requestSession(socket, token, {
      method: "uploadSubmission",
      upload: { remotePath: "/work/payload", maxBytes: 16 },
    }, Buffer.from("payload"))).resolves.toEqual({ bytes: 7 });
    expect(fake.uploads[0]?.content.toString()).toBe("payload");
    await expect(requestSession(socket, token, {
      method: "downloadArtifact",
      transfer: { remotePath: "/work/a", localPath: "/tmp/a", maxBytes: 1 },
    })).resolves.toMatchObject({ bytes: 1 });
    await expect(requestSession(socket, token, {
      method: "downloadArtifactBundle",
      transfer: {
        remoteDirectory: "/work/a", remoteArchivePath: "/work/a.tgz", localPath: "/tmp/a.tgz", maxBytes: 2,
      },
    })).resolves.toMatchObject({ bytes: 2 });
    await expect(requestSession(socket, token, { method: "unknown" }))
      .rejects.toMatchObject({ code: "SESSION_PROTOCOL_ERROR" });

    await expect(requestSession(socket, token, { method: "close" })).resolves.toEqual({ closed: true });
    active = undefined;
    const metadataPath = sessionPaths(sessionConfig(roots[0]!)).metadata;
    await waitFor(() => fake.closed && !existsSync(metadataPath));
  });

  it("rejects malformed framing without processing it", async () => {
    const { socket, token } = await startWorker();
    await expect(rawRequest(socket, "not-json\n")).resolves.toMatchObject({ ok: false });
    await expect(rawRequest(socket, `${JSON.stringify({ token, method: "ping", bodyLength: -1 })}\n`))
      .resolves.toMatchObject({ ok: false });
    await expect(rawRequest(socket, `${JSON.stringify({ token, method: "ping", bodyLength: 0 })}\ntrailing`))
      .resolves.toMatchObject({ ok: false });
  });
});
