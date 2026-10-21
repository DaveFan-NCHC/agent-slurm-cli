import { createConnection } from "node:net";
import type { SshConfig } from "../config/loader.js";
import { AgentError, ExitCode, type ErrorCode } from "../errors/errors.js";
import type {
  ArtifactDownload, RemoteExecutor, RemoteResult, SafeArtifactBundleTransfer,
  SafeArtifactTransfer, SafeCommand, SafeSubmissionUpload,
} from "../transport/types.js";
import { SshExecutor } from "../transport/ssh.js";
import { readSessionMetadata, removeSessionFiles, sessionPaths } from "./paths.js";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

interface RpcError {
  code: ErrorCode;
  message: string;
  exitCode: number;
  details?: Record<string, unknown>;
}

interface RpcResponse {
  ok: boolean;
  result?: unknown;
  error?: RpcError;
}

export interface SessionStatus {
  state: "connecting" | "ready" | "disconnected";
  created_at: string;
  last_activity_at: string;
  idle_expires_at: string;
  max_expires_at: string;
  command_connection: "ready" | "disconnected";
  transfer_connection: "shared" | "ready" | "disconnected";
}

export async function requestSession(
  socketPath: string,
  token: string,
  request: Record<string, unknown>,
  body?: Buffer,
  timeoutMs = 30000,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let received = Buffer.alloc(0);
    const finishReject = (error: AgentError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      reject(error);
    };
    const timeout = setTimeout(() => finishReject(new AgentError(
      "SESSION_LOST", "The persistent SSH session did not respond.", ExitCode.SshFailure,
    )), timeoutMs);
    socket.once("connect", () => {
      const header = Buffer.from(`${JSON.stringify({ ...request, token, bodyLength: body?.length ?? 0 })}\n`);
      socket.write(header);
      if (body && body.length > 0) socket.write(body);
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      received = Buffer.concat([received, chunk]);
      if (received.length > MAX_RESPONSE_BYTES) {
        finishReject(new AgentError(
          "SESSION_PROTOCOL_ERROR", "SSH session response exceeded its size limit.", ExitCode.SshFailure,
        ));
        return;
      }
      const newline = received.indexOf(0x0a);
      if (newline < 0) return;
      let response: RpcResponse;
      try {
        response = JSON.parse(received.subarray(0, newline).toString("utf8")) as RpcResponse;
      } catch {
        finishReject(new AgentError(
          "SESSION_PROTOCOL_ERROR", "SSH session returned an invalid response.", ExitCode.SshFailure,
        ));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.end();
      if (!response.ok) {
        const error = response.error;
        reject(new AgentError(
          error?.code ?? "SESSION_PROTOCOL_ERROR",
          error?.message ?? "SSH session request failed.",
          error?.exitCode ?? ExitCode.SshFailure,
          error?.details,
        ));
      } else {
        resolve(response.result);
      }
    });
    socket.once("error", () => finishReject(new AgentError(
      "SESSION_LOST", "The persistent SSH session is unavailable.", ExitCode.SshFailure,
    )));
    socket.once("close", () => {
      if (!settled) finishReject(new AgentError(
        "SESSION_LOST", "The persistent SSH session closed unexpectedly.", ExitCode.SshFailure,
      ));
    });
  });
}

export class SessionRemoteExecutor implements RemoteExecutor {
  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {}

  async run(command: SafeCommand): Promise<RemoteResult> {
    return await requestSession(
      this.socketPath, this.token, { method: "run", command }, undefined, this.timeoutMs,
    ) as RemoteResult;
  }

  async downloadArtifact(transfer: SafeArtifactTransfer): Promise<ArtifactDownload> {
    return await requestSession(
      this.socketPath, this.token, { method: "downloadArtifact", transfer }, undefined, this.timeoutMs,
    ) as ArtifactDownload;
  }

  async downloadArtifactBundle(transfer: SafeArtifactBundleTransfer): Promise<ArtifactDownload> {
    return await requestSession(
      this.socketPath, this.token, { method: "downloadArtifactBundle", transfer }, undefined, this.timeoutMs,
    ) as ArtifactDownload;
  }

  async uploadSubmission({ content, ...upload }: SafeSubmissionUpload): Promise<{ bytes: number }> {
    return await requestSession(
      this.socketPath,
      this.token,
      { method: "uploadSubmission", upload },
      content,
      this.timeoutMs,
    ) as { bytes: number };
  }

  async close(): Promise<void> {
    // The session worker owns the persistent connection lifecycle.
  }
}

export async function activeSessionExecutor(config: SshConfig): Promise<SessionRemoteExecutor | undefined> {
  const paths = sessionPaths(config);
  const metadata = readSessionMetadata(paths.metadata);
  if (!metadata) return undefined;
  try {
    const status = await requestSession(paths.socket, metadata.token, { method: "ping" }, undefined, 1500) as SessionStatus;
    if (status.state !== "ready") {
      if (status.state === "disconnected") {
        await requestSession(paths.socket, metadata.token, { method: "close" }, undefined, 1500).catch(() => undefined);
        removeSessionFiles(paths);
      }
      return undefined;
    }
    return new SessionRemoteExecutor(paths.socket, metadata.token, config.timeoutMs + 5000);
  } catch {
    try { removeSessionFiles(paths); } catch { /* fall back to a one-shot connection */ }
    return undefined;
  }
}

export class PreferredRemoteExecutor implements RemoteExecutor {
  private selected?: Promise<RemoteExecutor>;

  constructor(
    private readonly config: SshConfig,
    private readonly fallbackFactory: (config: SshConfig) => RemoteExecutor = (value) => new SshExecutor(value),
  ) {}

  private executor(): Promise<RemoteExecutor> {
    this.selected ??= activeSessionExecutor(this.config).then(
      (session) => session ?? this.fallbackFactory(this.config),
    );
    return this.selected;
  }

  async run(command: SafeCommand): Promise<RemoteResult> {
    return await (await this.executor()).run(command);
  }

  async downloadArtifact(transfer: SafeArtifactTransfer): Promise<ArtifactDownload> {
    return await (await this.executor()).downloadArtifact(transfer);
  }

  async downloadArtifactBundle(transfer: SafeArtifactBundleTransfer): Promise<ArtifactDownload> {
    return await (await this.executor()).downloadArtifactBundle(transfer);
  }

  async uploadSubmission(upload: SafeSubmissionUpload): Promise<{ bytes: number }> {
    return await (await this.executor()).uploadSubmission(upload);
  }

  async close(): Promise<void> {
    if (this.selected) await (await this.selected).close();
  }
}
