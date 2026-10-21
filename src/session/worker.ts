import { randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { loadConfig } from "../config/loader.js";
import { AgentError, ExitCode } from "../errors/errors.js";
import { SshExecutor } from "../transport/ssh.js";
import type {
  SafeArtifactBundleTransfer, SafeArtifactTransfer, SafeCommand, SafeSubmissionUpload,
} from "../transport/types.js";
import {
  ensureSessionDirectory, readSessionMetadata, removeSessionFiles, sessionPaths, type SessionMetadata,
} from "./paths.js";

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 1024 * 1024 * 1024;

interface WorkerRequest {
  token?: string;
  method?: string;
  bodyLength?: number;
  command?: SafeCommand;
  transfer?: SafeArtifactTransfer | SafeArtifactBundleTransfer;
  upload?: Omit<SafeSubmissionUpload, "content">;
}

function serializeError(cause: unknown): Record<string, unknown> {
  const error = cause instanceof AgentError
    ? cause
    : new AgentError("SESSION_PROTOCOL_ERROR", "Persistent session worker failed.", ExitCode.SshFailure);
  return {
    code: error.code,
    message: error.message,
    exitCode: error.exitCode,
    details: error.details,
  };
}

function writeResponse(socket: Socket, response: Record<string, unknown>): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

export async function runSessionWorker(): Promise<void> {
  const config = loadConfig(process.env);
  const paths = sessionPaths(config.ssh);
  ensureSessionDirectory(paths.directory);
  const token = randomBytes(32).toString("hex");
  const createdAtMs = Date.now();
  let lastActivityAtMs = createdAtMs;
  let state: "connecting" | "ready" | "disconnected" = "connecting";
  let shuttingDown = false;
  let expiryTimer: NodeJS.Timeout | undefined;
  let operationQueue: Promise<void> = Promise.resolve();
  const executor = new SshExecutor(config.ssh);

  const status = (): Record<string, unknown> => {
    const connections = executor.connectionStatus();
    if (state === "ready" && !executor.isConnected()) state = "disconnected";
    return {
      state,
      created_at: new Date(createdAtMs).toISOString(),
      last_activity_at: new Date(lastActivityAtMs).toISOString(),
      idle_expires_at: new Date(lastActivityAtMs + config.ssh.sessionIdleTimeoutMs).toISOString(),
      max_expires_at: new Date(createdAtMs + config.ssh.sessionMaxLifetimeMs).toISOString(),
      command_connection: connections.command ? "ready" : "disconnected",
      transfer_connection: connections.transfer === "shared"
        ? "shared"
        : connections.transfer ? "ready" : "disconnected",
    };
  };

  const server = createServer((socket) => {
    let buffered = Buffer.alloc(0);
    let parsed: WorkerRequest | undefined;
    let bodyLength = 0;
    let handling = false;

    const failProtocol = (message: string): void => writeResponse(socket, {
      ok: false,
      error: serializeError(new AgentError("SESSION_PROTOCOL_ERROR", message, ExitCode.SshFailure)),
    });

    const handle = async (request: WorkerRequest, body: Buffer): Promise<void> => {
      if (request.token !== token) {
        failProtocol("Persistent session authentication failed.");
        return;
      }
      try {
        let result: unknown;
        switch (request.method) {
          case "ping":
            result = status();
            break;
          case "open":
            if (state !== "ready") {
              state = "connecting";
              await executor.open();
              executor.preventReconnect();
              state = "ready";
              lastActivityAtMs = Date.now();
              scheduleExpiry();
            }
            result = status();
            break;
          case "run":
            if (state !== "ready" || !request.command) throw new AgentError(
              "SESSION_LOST", "The persistent SSH session is not ready.", ExitCode.SshFailure,
            );
            result = await executor.run(request.command);
            lastActivityAtMs = Date.now();
            scheduleExpiry();
            break;
          case "downloadArtifact":
            if (state !== "ready" || !request.transfer) throw new AgentError(
              "SESSION_LOST", "The persistent SSH session is not ready.", ExitCode.SshFailure,
            );
            result = await executor.downloadArtifact(request.transfer as SafeArtifactTransfer);
            lastActivityAtMs = Date.now();
            scheduleExpiry();
            break;
          case "downloadArtifactBundle":
            if (state !== "ready" || !request.transfer) throw new AgentError(
              "SESSION_LOST", "The persistent SSH session is not ready.", ExitCode.SshFailure,
            );
            result = await executor.downloadArtifactBundle(request.transfer as SafeArtifactBundleTransfer);
            lastActivityAtMs = Date.now();
            scheduleExpiry();
            break;
          case "uploadSubmission":
            if (state !== "ready" || !request.upload) throw new AgentError(
              "SESSION_LOST", "The persistent SSH session is not ready.", ExitCode.SshFailure,
            );
            result = await executor.uploadSubmission({ ...request.upload, content: body });
            lastActivityAtMs = Date.now();
            scheduleExpiry();
            break;
          case "close":
            result = { closed: true };
            writeResponse(socket, { ok: true, result });
            setImmediate(() => { void shutdown(); });
            return;
          default:
            throw new AgentError(
              "SESSION_PROTOCOL_ERROR", "Unknown persistent session request.", ExitCode.SshFailure,
            );
        }
        writeResponse(socket, { ok: true, result });
      } catch (cause) {
        if (state === "ready" && !executor.isConnected()) state = "disconnected";
        writeResponse(socket, { ok: false, error: serializeError(cause) });
        if (request.method === "open") setImmediate(() => { void shutdown(); });
      }
    };

    socket.on("data", (chunk: Buffer) => {
      if (handling) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (!parsed) {
        const newline = buffered.indexOf(0x0a);
        if ((newline < 0 && buffered.length > MAX_HEADER_BYTES) || newline > MAX_HEADER_BYTES) {
          failProtocol("Persistent session request header exceeded its size limit.");
          handling = true;
          return;
        }
        if (newline < 0) return;
        try {
          parsed = JSON.parse(buffered.subarray(0, newline).toString("utf8")) as WorkerRequest;
        } catch {
          failProtocol("Persistent session request was invalid.");
          handling = true;
          return;
        }
        bodyLength = parsed.bodyLength ?? 0;
        if (!Number.isInteger(bodyLength) || bodyLength < 0 || bodyLength > MAX_BODY_BYTES) {
          failProtocol("Persistent session request body length was invalid.");
          handling = true;
          return;
        }
        buffered = buffered.subarray(newline + 1);
      }
      if (buffered.length < bodyLength) return;
      if (buffered.length > bodyLength) {
        failProtocol("Persistent session request contained trailing data.");
        handling = true;
        return;
      }
      handling = true;
      if (parsed.method === "ping") {
        void handle(parsed, buffered);
      } else {
        operationQueue = operationQueue.then(() => handle(parsed!, buffered)).catch(() => undefined);
      }
    });
    socket.once("error", () => socket.destroy());
  });

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (expiryTimer) clearTimeout(expiryTimer);
    server.close();
    await executor.close().catch(() => undefined);
    try {
      const current = readSessionMetadata(paths.metadata);
      if (current?.token === token) removeSessionFiles(paths);
    } catch { /* best-effort cleanup */ }
  };

  const scheduleExpiry = (): void => {
    if (expiryTimer) clearTimeout(expiryTimer);
    const expiresAt = Math.min(
      lastActivityAtMs + config.ssh.sessionIdleTimeoutMs,
      createdAtMs + config.ssh.sessionMaxLifetimeMs,
    );
    expiryTimer = setTimeout(() => { void shutdown(); }, Math.max(1, expiresAt - Date.now()));
    expiryTimer.unref();
  };

  const metadata: SessionMetadata = {
    version: 1,
    pid: process.pid,
    token,
    createdAt: new Date(createdAtMs).toISOString(),
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => {
      try {
        chmodSync(paths.socket, 0o600);
        writeFileSync(paths.metadata, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
        resolve();
      } catch (cause) {
        server.close();
        reject(cause);
      }
    });
  });
  scheduleExpiry();
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
}
