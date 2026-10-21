import { createHash } from "node:crypto";
import {
  lstatSync, mkdirSync, readFileSync, unlinkSync, type Stats,
} from "node:fs";
import { join } from "node:path";
import type { SshConfig, SshConnectionConfig } from "../config/loader.js";
import { AgentError, ExitCode } from "../errors/errors.js";

export interface SessionMetadata {
  version: 1;
  pid: number;
  token: string;
  createdAt: string;
}

export interface SessionPaths {
  directory: string;
  socket: string;
  metadata: string;
}

function connectionIdentity(config: SshConnectionConfig): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    authentication: config.authentication.type === "private-key"
      ? { type: config.authentication.type, keyPath: config.authentication.keyPath }
      : { type: config.authentication.type },
    knownHostsPath: config.knownHostsPath,
    hostFingerprint: config.hostFingerprint,
  };
}

export function sessionPaths(config: SshConfig): SessionPaths {
  const identity = JSON.stringify({
    command: connectionIdentity(config),
    transfer: config.sftp ? connectionIdentity(config.sftp) : undefined,
  });
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  const socket = join(config.sessionDirectory, `${key}.sock`);
  if (Buffer.byteLength(socket) > 100) {
    throw new AgentError(
      "CONFIGURATION_ERROR",
      "SLURM_SSH_SESSION_DIR is too long for a Unix socket path.",
      ExitCode.General,
    );
  }
  return {
    directory: config.sessionDirectory,
    socket,
    metadata: join(config.sessionDirectory, `${key}.json`),
  };
}

function validateOwnerAndMode(stats: Stats, description: string): void {
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new AgentError(
      "CONFIGURATION_ERROR",
      `${description} must be owned by the current user.`,
      ExitCode.General,
    );
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new AgentError(
      "CONFIGURATION_ERROR",
      `${description} must not be accessible by group or other users.`,
      ExitCode.General,
    );
  }
}

export function ensureSessionDirectory(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("not a real directory");
    validateOwnerAndMode(stats, "SSH session directory");
  } catch (cause) {
    if (cause instanceof AgentError) throw cause;
    throw new AgentError(
      "CONFIGURATION_ERROR",
      `Unable to use SSH session directory: ${(cause as Error).message}`,
      ExitCode.General,
    );
  }
}

export function readSessionMetadata(path: string): SessionMetadata | undefined {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
    validateOwnerAndMode(stats, "SSH session metadata");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionMetadata>;
    if (parsed.version !== 1 || !Number.isInteger(parsed.pid) || typeof parsed.token !== "string"
        || parsed.token.length < 32 || typeof parsed.createdAt !== "string") return undefined;
    return parsed as SessionMetadata;
  } catch (cause) {
    if (cause instanceof AgentError) throw cause;
    return undefined;
  }
}

export function removeSessionFiles(paths: SessionPaths): void {
  for (const path of [paths.socket, paths.metadata]) {
    try { unlinkSync(path); } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
}
