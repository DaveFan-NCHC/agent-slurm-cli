import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, linkSync, readFileSync, unlinkSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Client, type ConnectConfig, type ClientChannel, type SFTPWrapper } from "ssh2";
import type { SshConfig } from "../config/loader.js";
import { AgentError, ExitCode } from "../errors/errors.js";
import { renderCommand, type RemoteExecutor, type RemoteResult, type SafeArtifactTransfer, type SafeCommand, type SafeSubmissionUpload } from "./types.js";

interface KnownHostEntry { hosts: string[]; key: Buffer }

function readKnownHosts(path: string): KnownHostEntry[] {
  return readFileSync(path, "utf8").split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("@")) return [];
    const fields = trimmed.split(/\s+/);
    if (fields.length < 3 || fields[0]!.startsWith("|1|")) return [];
    try {
      return [{ hosts: fields[0]!.split(","), key: Buffer.from(fields[2]!, "base64") }];
    } catch {
      return [];
    }
  });
}

function normalizeFingerprint(value: string): string {
  return value.replace(/^SHA256:/i, "").replace(/=+$/, "");
}

function constantEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function makeHostVerifier(config: SshConfig): (key: Buffer) => boolean {
  if (config.hostFingerprint) {
    const expected = normalizeFingerprint(config.hostFingerprint);
    return (key) => createHash("sha256").update(key).digest("base64").replace(/=+$/, "") === expected;
  }
  const entries = readKnownHosts(config.knownHostsPath!);
  const names = config.port === 22 ? [config.host, `[${config.host}]:22`] : [`[${config.host}]:${config.port}`];
  const candidates = entries.filter((entry) => entry.hosts.some((host) => names.includes(host)));
  if (candidates.length === 0) {
    throw new AgentError(
      "SSH_HOST_VERIFICATION_FAILED",
      `No plain-text known_hosts entry matches ${config.host}:${config.port}.`,
      ExitCode.SshFailure,
    );
  }
  return (key) => candidates.some((candidate) => constantEqual(candidate.key, key));
}

function appendLimited(chunks: Buffer[], chunk: Buffer, state: { size: number; truncated: boolean }, limit: number): void {
  if (state.size >= limit) { state.truncated = true; return; }
  const remaining = limit - state.size;
  if (chunk.length > remaining) state.truncated = true;
  const accepted = chunk.subarray(0, remaining);
  chunks.push(accepted);
  state.size += accepted.length;
}

export class SshExecutor implements RemoteExecutor {
  private client?: Client;
  private connecting?: Promise<Client>;

  constructor(private readonly config: SshConfig) {}

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<Client>((resolve, reject) => {
      const client = new Client();
      let hostVerified = false;
      let verifierCalled = false;
      let settled = false;
      let verifier: (key: Buffer) => boolean;
      try { verifier = makeHostVerifier(this.config); } catch (error) { reject(error); return; }
      const finishReject = (error: AgentError): void => {
        if (settled) return;
        settled = true;
        this.connecting = undefined;
        client.end();
        reject(error);
      };
      client.once("ready", () => {
        settled = true;
        this.client = client;
        resolve(client);
      });
      client.once("error", (cause: Error & { level?: string }) => {
        const auth = cause.level === "client-authentication";
        const code = verifierCalled && !hostVerified ? "SSH_HOST_VERIFICATION_FAILED" : auth ? "SSH_AUTH_FAILED" : "SSH_CONNECTION_FAILED";
        finishReject(new AgentError(code, `SSH connection failed: ${cause.message}`, ExitCode.SshFailure));
      });
      client.once("close", () => { this.client = undefined; this.connecting = undefined; });
      const connection: ConnectConfig = {
        host: this.config.host,
        port: this.config.port,
        username: this.config.user,
        privateKey: readFileSync(this.config.keyPath),
        readyTimeout: this.config.timeoutMs,
        hostVerifier: (key: Buffer) => { verifierCalled = true; hostVerified = verifier(key); return hostVerified; },
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      };
      client.connect(connection);
    });
    return this.connecting;
  }

  async run(command: SafeCommand): Promise<RemoteResult> {
    const client = await this.connect();
    const rendered = renderCommand(command);
    const limit = command.maxOutputBytes ?? 4 * 1024 * 1024;
    return await new Promise<RemoteResult>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        channel?.close();
        reject(new AgentError("REMOTE_COMMAND_TIMEOUT", "Remote command timed out.", ExitCode.SshFailure));
      }, this.config.timeoutMs);
      let channel: ClientChannel | undefined;
      client.exec(rendered, (error, stream) => {
        if (error) {
          clearTimeout(timeout);
          settled = true;
          reject(new AgentError("SSH_CONNECTION_FAILED", `Unable to execute remote command: ${error.message}`, ExitCode.SshFailure));
          return;
        }
        channel = stream;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const outState = { size: 0, truncated: false };
        const errState = { size: 0, truncated: false };
        stream.on("data", (chunk: Buffer) => appendLimited(stdout, Buffer.from(chunk), outState, limit));
        stream.stderr.on("data", (chunk: Buffer) => appendLimited(stderr, Buffer.from(chunk), errState, limit));
        stream.once("error", (cause: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(new AgentError("SSH_CONNECTION_FAILED", `Remote channel failed: ${cause.message}`, ExitCode.SshFailure));
        });
        stream.once("close", (code: number | undefined, signal: string | undefined) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            exitCode: code ?? 255,
            signal,
            stdoutTruncated: outState.truncated,
            stderrTruncated: errState.truncated,
          });
        });
      });
    });
  }

  async downloadArtifact({ remotePath, localPath, maxBytes }: SafeArtifactTransfer): Promise<{ bytes: number }> {
    const client = await this.connect();
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, session) => {
        if (error) reject(new AgentError("ARTIFACT_DOWNLOAD_FAILED", `Unable to start controlled artifact transfer: ${error.message}`, ExitCode.SshFailure));
        else resolve(session);
      });
    });
    const temporaryPath = `${localPath}.part-${process.pid}-${randomUUID()}`;
    let temporaryCreated = false;
    try {
      const attributes = await new Promise<import("ssh2").Stats>((resolve, reject) => {
        sftp.stat(remotePath, (error, stats) => error ? reject(error) : resolve(stats));
      });
      if (!attributes.isFile()) {
        throw new AgentError("ARTIFACT_NOT_FOUND", "Remote artifact is not a regular file.", ExitCode.NotFound);
      }
      if (attributes.size > maxBytes) {
        throw new AgentError("ARTIFACT_TOO_LARGE", `Artifact exceeds policy maximum ${maxBytes} bytes.`, ExitCode.PolicyDenied);
      }
      let bytes = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > maxBytes) callback(new AgentError("ARTIFACT_TOO_LARGE", `Artifact exceeds policy maximum ${maxBytes} bytes.`, ExitCode.PolicyDenied));
          else callback(null, chunk);
        },
      });
      const output = createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
      await once(output, "open");
      temporaryCreated = true;
      const controller = new AbortController();
      const transferTimeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        await pipeline(sftp.createReadStream(remotePath), limiter, output, { signal: controller.signal });
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new AgentError("REMOTE_COMMAND_TIMEOUT", "Artifact download timed out.", ExitCode.SshFailure);
        }
        throw cause;
      } finally {
        clearTimeout(transferTimeout);
      }
      try {
        linkSync(temporaryPath, localPath);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
          throw new AgentError("ARTIFACT_ALREADY_EXISTS", "The local artifact already exists; overwriting is not permitted.", ExitCode.General);
        }
        throw cause;
      }
      try { unlinkSync(temporaryPath); } catch { /* destination is already installed atomically */ }
      temporaryCreated = false;
      return { bytes };
    } catch (cause) {
      if (temporaryCreated) {
        try { unlinkSync(temporaryPath); } catch { /* best-effort temporary cleanup */ }
      }
      if (cause instanceof AgentError) throw cause;
      throw new AgentError("ARTIFACT_DOWNLOAD_FAILED", `Artifact download failed: ${(cause as Error).message}`, ExitCode.SshFailure);
    } finally {
      sftp.end();
    }
  }

  async uploadSubmission({ content, remotePath, maxBytes }: SafeSubmissionUpload): Promise<{ bytes: number }> {
    if (content.length > maxBytes) {
      throw new AgentError("SCRIPT_TOO_LARGE", `Job script exceeds policy maximum ${maxBytes} bytes.`, ExitCode.PolicyDenied);
    }
    const client = await this.connect();
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, session) => {
        if (error) reject(new AgentError("SCRIPT_UPLOAD_FAILED", `Unable to start controlled script upload: ${error.message}`, ExitCode.SshFailure));
        else resolve(session);
      });
    });
    const temporaryPath = `${remotePath}.part-${randomUUID()}`;
    let temporaryCreated = false;
    try {
      const output = sftp.createWriteStream(temporaryPath, { flags: "wx", mode: 0o700 });
      await once(output, "open");
      temporaryCreated = true;
      const controller = new AbortController();
      const uploadTimeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        await pipeline(Readable.from(content), output, { signal: controller.signal });
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new AgentError("REMOTE_COMMAND_TIMEOUT", "Job script upload timed out.", ExitCode.SshFailure);
        }
        throw cause;
      } finally {
        clearTimeout(uploadTimeout);
      }
      await new Promise<void>((resolve, reject) => {
        sftp.rename(temporaryPath, remotePath, (error) => error ? reject(error) : resolve());
      });
      temporaryCreated = false;
      return { bytes: content.length };
    } catch (cause) {
      if (temporaryCreated) {
        await new Promise<void>((resolve) => sftp.unlink(temporaryPath, () => resolve()));
      }
      if (cause instanceof AgentError) throw cause;
      throw new AgentError("SCRIPT_UPLOAD_FAILED", `Job script upload failed: ${(cause as Error).message}`, ExitCode.SshFailure);
    } finally {
      sftp.end();
    }
  }

  async close(): Promise<void> {
    this.client?.end();
    this.client = undefined;
    this.connecting = undefined;
  }
}
