import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, linkSync, lstatSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Client, type ConnectConfig, type ClientChannel, type SFTPWrapper } from "ssh2";
import type { SshConfig, SshConnectionConfig } from "../config/loader.js";
import { AgentError, ExitCode } from "../errors/errors.js";
import {
  renderCommand, shellEscape, type ArtifactDownload, type RemoteExecutor, type RemoteResult,
  type SafeArtifactBundleTransfer, type SafeArtifactTransfer, type SafeCommand, type SafeSubmissionUpload,
} from "./types.js";

const ARTIFACT_BUNDLE_SCRIPT = String.raw`set -uo pipefail; set -C; umask 077; cd -- "$1" || exit 74; if [ -n "$5" ]; then start="./$5"; [ -d "$start" ] && [ ! -L "$start" ] || exit 75; else start=.; fi; { if [ -n "$5" ]; then find . -xdev -regextype posix-extended -type f -path "./$5/*" -regex './[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*' -printf '%P\0'; else find . -xdev -regextype posix-extended -type f -regex './[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*' -printf '%P\0'; fi; } | tar --create --gzip --file=- --null --verbatim-files-from --no-recursion --files-from=- | head --bytes="$4" > "$2"; bundle_status=$?; bundle_bytes=$(wc -c < "$2") || exit 74; if [ "$bundle_bytes" -gt "$3" ]; then exit 73; fi; exit "$bundle_status"`;

const SAFE_BUNDLE_PREFIX = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export function renderArtifactBundleCommand(
  remoteDirectory: string,
  remoteArchivePath: string,
  maxBytes: number,
  prefix?: string,
): string {
  if (prefix !== undefined && (
    !SAFE_BUNDLE_PREFIX.test(prefix) || prefix.split("/").some((segment) => segment === "." || segment === "..")
  )) {
    throw new Error("Artifact bundle prefix is not a safe relative path.");
  }
  return [
    shellEscape("/bin/bash"), shellEscape("-c"), shellEscape(ARTIFACT_BUNDLE_SCRIPT),
    shellEscape("slurm-agent-artifacts-download"), shellEscape(remoteDirectory), shellEscape(remoteArchivePath),
    shellEscape(String(maxBytes)), shellEscape(String(Math.min(Number.MAX_SAFE_INTEGER, maxBytes + 1))),
    shellEscape(prefix ?? ""),
  ].join(" ");
}

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

function makeHostVerifier(config: SshConnectionConfig): (key: Buffer) => boolean {
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
  private readonly commandConnection: { client?: Client; connecting?: Promise<Client> } = {};
  private readonly transferConnection: { client?: Client; connecting?: Promise<Client> } = {};

  constructor(private readonly config: SshConfig) {}

  private connect(
    config: SshConnectionConfig,
    state: { client?: Client; connecting?: Promise<Client> },
  ): Promise<Client> {
    if (state.client) return Promise.resolve(state.client);
    if (state.connecting) return state.connecting;
    state.connecting = new Promise<Client>((resolve, reject) => {
      const client = new Client();
      let hostVerified = false;
      let verifierCalled = false;
      let settled = false;
      let primaryAttempted = false;
      let pushAttempted = false;
      let passwordPromptAnswered = false;
      let verifier: (key: Buffer) => boolean;
      try { verifier = makeHostVerifier(config); } catch (error) { reject(error); return; }
      const finishReject = (error: AgentError): void => {
        if (settled) return;
        settled = true;
        state.connecting = undefined;
        client.end();
        reject(error);
      };
      client.once("ready", () => {
        if (config.authentication.type === "keyboard-interactive-password" && !passwordPromptAnswered) {
          finishReject(new AgentError(
            "SSH_AUTH_FAILED",
            "SSH keyboard-interactive authentication completed without the required password prompt.",
            ExitCode.SshFailure,
          ));
          return;
        }
        const combinedPamPushCompleted = config.authentication.type === "keyboard-interactive-password"
          && passwordPromptAnswered;
        if (config.pushAuthentication && !pushAttempted && !combinedPamPushCompleted) {
          finishReject(new AgentError(
            "SSH_AUTH_FAILED",
            "SSH authentication completed without the required push approval.",
            ExitCode.SshFailure,
          ));
          return;
        }
        settled = true;
        state.client = client;
        resolve(client);
      });
      client.on("error", (cause: Error & { level?: string }) => {
        if (settled) return;
        if (config.pushAuthentication && cause.level === "client-timeout") {
          finishReject(new AgentError(
            "SSH_AUTH_FAILED",
            "SSH push approval timed out or was not completed.",
            ExitCode.SshFailure,
          ));
          return;
        }
        const auth = cause.level === "client-authentication";
        const code = verifierCalled && !hostVerified ? "SSH_HOST_VERIFICATION_FAILED" : auth ? "SSH_AUTH_FAILED" : "SSH_CONNECTION_FAILED";
        finishReject(new AgentError(code, `SSH connection failed: ${cause.message}`, ExitCode.SshFailure));
      });
      client.once("close", () => { state.client = undefined; state.connecting = undefined; });
      if (config.pushAuthentication || config.authentication.type === "keyboard-interactive-password") {
        client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
          if (config.authentication.type === "keyboard-interactive-password"
              && !passwordPromptAnswered && prompts.length === 1 && prompts[0]?.echo === false) {
            passwordPromptAnswered = true;
            finish([config.authentication.password]);
            return;
          }
          finishReject(new AgentError(
            "SSH_AUTH_FAILED",
            "SSH keyboard-interactive authentication requested an unsupported prompt.",
            ExitCode.SshFailure,
          ));
        });
      }
      const authentication: Pick<ConnectConfig, "privateKey" | "password"> =
        config.authentication.type === "private-key"
          ? { privateKey: readFileSync(config.authentication.keyPath) }
          : config.authentication.type === "password"
            ? { password: config.authentication.password }
            : {};
      const primaryMethod = config.authentication.type === "private-key"
        ? "publickey"
        : config.authentication.type === "password" ? "password" : "keyboard-interactive";
      const explicitAuthentication = config.pushAuthentication
        || config.authentication.type === "keyboard-interactive-password";
      const authHandler: ConnectConfig["authHandler"] = explicitAuthentication
        ? (methodsLeft, partialSuccess, next) => {
            if (!primaryAttempted) {
              primaryAttempted = true;
              next(primaryMethod);
              return;
            }
            if (!pushAttempted && partialSuccess && methodsLeft.includes("keyboard-interactive")) {
              pushAttempted = true;
              next("keyboard-interactive");
              return;
            }
            next(false as never);
          }
        : undefined;
      const connection: ConnectConfig = {
        host: config.host,
        port: config.port,
        username: config.user,
        ...authentication,
        tryKeyboard: explicitAuthentication,
        ...(authHandler ? { authHandler } : {}),
        readyTimeout: config.readyTimeoutMs,
        hostVerifier: (key: Buffer) => { verifierCalled = true; hostVerified = verifier(key); return hostVerified; },
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      };
      client.connect(connection);
    });
    return state.connecting;
  }

  private connectForCommands(): Promise<Client> {
    return this.connect(this.config, this.commandConnection);
  }

  private connectForTransfer(): Promise<Client> {
    return this.config.sftp
      ? this.connect(this.config.sftp, this.transferConnection)
      : this.connectForCommands();
  }

  private async runRendered(rendered: string, limit: number): Promise<RemoteResult> {
    const client = await this.connectForCommands();
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

  async run(command: SafeCommand): Promise<RemoteResult> {
    return await this.runRendered(renderCommand(command), command.maxOutputBytes ?? 4 * 1024 * 1024);
  }

  private async remoteSha256(remotePath: string): Promise<string> {
    const result = await this.run({ executable: "sha256sum", args: ["--", remotePath], maxOutputBytes: 256 });
    const match = /^([a-f0-9]{64})(?:\s|$)/i.exec(result.stdout);
    if (result.exitCode !== 0 || result.stdoutTruncated === true || !match) {
      throw new AgentError(
        "ARTIFACT_DOWNLOAD_FAILED",
        "Unable to calculate the remote artifact SHA-256 checksum.",
        ExitCode.SshFailure,
        { remote_exit_code: result.exitCode, stderr_truncated: result.stderrTruncated === true },
      );
    }
    return match[1]!.toLowerCase();
  }

  private async downloadVerifiedArtifact(
    { remotePath, localPath, maxBytes, overwrite = false }: SafeArtifactTransfer,
    expectedSha256: string,
  ): Promise<ArtifactDownload> {
    const client = await this.connectForTransfer();
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
      const hash = createHash("sha256");
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > maxBytes) callback(new AgentError("ARTIFACT_TOO_LARGE", `Artifact exceeds policy maximum ${maxBytes} bytes.`, ExitCode.PolicyDenied));
          else {
            hash.update(chunk);
            callback(null, chunk);
          }
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
      const sha256 = hash.digest("hex");
      if (!constantEqual(Buffer.from(sha256, "hex"), Buffer.from(expectedSha256, "hex"))) {
        throw new AgentError(
          "ARTIFACT_CHECKSUM_MISMATCH",
          "Downloaded artifact SHA-256 does not match the remote checksum.",
          ExitCode.SshFailure,
        );
      }
      let overwritten = false;
      if (overwrite) {
        try {
          const existing = lstatSync(localPath);
          if (!existing.isFile()) {
            throw new AgentError(
              "LOCAL_PATH_NOT_ALLOWED", "--force may replace only an existing regular file.", ExitCode.PolicyDenied,
            );
          }
          overwritten = true;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
        renameSync(temporaryPath, localPath);
      } else {
        try {
          linkSync(temporaryPath, localPath);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
            throw new AgentError("ARTIFACT_ALREADY_EXISTS", "The local artifact already exists; overwriting is not permitted.", ExitCode.General);
          }
          throw cause;
        }
        try { unlinkSync(temporaryPath); } catch { /* destination is already installed atomically */ }
      }
      temporaryCreated = false;
      return { bytes, sha256, overwritten };
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

  async downloadArtifact(transfer: SafeArtifactTransfer): Promise<ArtifactDownload> {
    const expectedSha256 = await this.remoteSha256(transfer.remotePath);
    return await this.downloadVerifiedArtifact(transfer, expectedSha256);
  }

  async downloadArtifactBundle(
    { remoteDirectory, remoteArchivePath, localPath, maxBytes, prefix, overwrite }: SafeArtifactBundleTransfer,
  ): Promise<ArtifactDownload> {
    try {
      const created = await this.runRendered(
        renderArtifactBundleCommand(remoteDirectory, remoteArchivePath, maxBytes, prefix),
        4096,
      );
      if (created.exitCode === 73) {
        throw new AgentError(
          "ARTIFACT_TOO_LARGE", `Artifact bundle exceeds policy maximum ${maxBytes} bytes.`, ExitCode.PolicyDenied,
        );
      }
      if (created.exitCode !== 0) {
        throw new AgentError(
          "ARTIFACT_DOWNLOAD_FAILED",
          "Remote artifact bundle creation failed.",
          ExitCode.SshFailure,
          {
            remote_exit_code: created.exitCode,
            remote_signal: created.signal,
            stderr_truncated: created.stderrTruncated === true,
          },
        );
      }
      return await this.downloadArtifact({ remotePath: remoteArchivePath, localPath, maxBytes, overwrite });
    } finally {
      await this.run({ executable: "rm", args: ["-f", "--", remoteArchivePath] }).catch(() => undefined);
    }
  }

  async uploadSubmission({
    content, remotePath, maxBytes, mode = 0o600, label = "input",
  }: SafeSubmissionUpload): Promise<{ bytes: number }> {
    if (content.length > maxBytes) {
      throw new AgentError(
        "RESOURCE_LIMIT_EXCEEDED", `${label} exceeds controlled upload maximum ${maxBytes} bytes.`, ExitCode.PolicyDenied,
      );
    }
    const client = await this.connectForTransfer();
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, session) => {
        if (error) reject(new AgentError(
          "SUBMISSION_UPLOAD_FAILED", `Unable to start controlled ${label} upload: ${error.message}`, ExitCode.SshFailure,
        ));
        else resolve(session);
      });
    });
    const temporaryPath = `${remotePath}.part-${randomUUID()}`;
    let temporaryCreated = false;
    try {
      const output = sftp.createWriteStream(temporaryPath, { flags: "wx", mode });
      await once(output, "open");
      temporaryCreated = true;
      const controller = new AbortController();
      const uploadTimeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        await pipeline(Readable.from(content), output, { signal: controller.signal });
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new AgentError("REMOTE_COMMAND_TIMEOUT", `Controlled ${label} upload timed out.`, ExitCode.SshFailure);
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
      throw new AgentError(
        "SUBMISSION_UPLOAD_FAILED", `Controlled ${label} upload failed: ${(cause as Error).message}`, ExitCode.SshFailure,
      );
    } finally {
      sftp.end();
    }
  }

  async close(): Promise<void> {
    this.commandConnection.client?.end();
    this.transferConnection.client?.end();
    this.commandConnection.client = undefined;
    this.commandConnection.connecting = undefined;
    this.transferConnection.client = undefined;
    this.transferConnection.connecting = undefined;
  }
}
