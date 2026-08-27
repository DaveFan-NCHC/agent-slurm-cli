import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, type ConnectConfig, type ClientChannel } from "ssh2";
import type { SshConfig } from "../config/loader.js";
import { AgentError, ExitCode } from "../errors/errors.js";
import { renderCommand, type RemoteExecutor, type RemoteResult, type SafeCommand } from "./types.js";

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

  async close(): Promise<void> {
    this.client?.end();
    this.client = undefined;
    this.connecting = undefined;
  }
}
