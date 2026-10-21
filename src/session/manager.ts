import { spawn } from "node:child_process";
import type { SshConfig } from "../config/loader.js";
import { AgentError, ExitCode } from "../errors/errors.js";
import { requestSession, type SessionStatus } from "./client.js";
import {
  ensureSessionDirectory, readSessionMetadata, removeSessionFiles, sessionPaths,
} from "./paths.js";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface SessionManagerDependencies {
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  startWorker?: (cliModulePath: string, environment: NodeJS.ProcessEnv) => void;
}

function startWorker(cliModulePath: string, environment: NodeJS.ProcessEnv): void {
  const child = spawn(process.execPath, [cliModulePath, "__session-worker"], {
    detached: true,
    env: environment,
    stdio: "ignore",
  });
  child.unref();
}

async function statusFor(config: SshConfig): Promise<SessionStatus | undefined> {
  const paths = sessionPaths(config);
  const metadata = readSessionMetadata(paths.metadata);
  if (!metadata) return undefined;
  try {
    return await requestSession(paths.socket, metadata.token, { method: "ping" }, undefined, 1500) as SessionStatus;
  } catch {
    try { removeSessionFiles(paths); } catch { /* a later open will report any filesystem failure */ }
    return undefined;
  }
}

export async function openSession(
  config: SshConfig,
  cliModulePath: string,
  workerEnvironment: NodeJS.ProcessEnv = process.env,
  dependencies: SessionManagerDependencies = {},
): Promise<Record<string, unknown>> {
  const paths = sessionPaths(config);
  ensureSessionDirectory(paths.directory);
  let metadata = readSessionMetadata(paths.metadata);
  if (metadata) {
    try {
      const current = await requestSession(
        paths.socket, metadata.token, { method: "ping" }, undefined, 1500,
      ) as SessionStatus;
      if (current.state === "ready") return { ...current, reused: true };
      if (current.state === "connecting") {
        const opened = await requestSession(
          paths.socket,
          metadata.token,
          { method: "open" },
          undefined,
          config.readyTimeoutMs * (config.sftp ? 2 : 1) + 10000,
        ) as SessionStatus;
        return { ...opened, reused: true };
      }
      await requestSession(paths.socket, metadata.token, { method: "close" }, undefined, 1500).catch(() => undefined);
    } catch {
      // Stale metadata is removed before starting a replacement worker.
    }
    removeSessionFiles(paths);
  }
  if (!metadata) removeSessionFiles(paths);

  (dependencies.startWorker ?? startWorker)(cliModulePath, {
    ...workerEnvironment,
    SLURM_AGENT_INTERNAL_SESSION_WORKER: "1",
  });

  const now = dependencies.now ?? Date.now;
  const wait = dependencies.delay ?? delay;
  const startupDeadline = now() + 5000;
  do {
    await wait(25);
    metadata = readSessionMetadata(paths.metadata);
    if (metadata) break;
  } while (now() < startupDeadline);
  if (!metadata) {
    throw new AgentError(
      "SESSION_LOST",
      "Persistent SSH session worker did not start.",
      ExitCode.SshFailure,
    );
  }

  try {
    const opened = await requestSession(
      paths.socket,
      metadata.token,
      { method: "open" },
      undefined,
      config.readyTimeoutMs * (config.sftp ? 2 : 1) + 10000,
    ) as SessionStatus;
    return { ...opened, reused: false };
  } catch (cause) {
    await requestSession(paths.socket, metadata.token, { method: "close" }, undefined, 1500).catch(() => undefined);
    throw cause;
  }
}

export async function inspectSession(config: SshConfig): Promise<Record<string, unknown>> {
  ensureSessionDirectory(config.sessionDirectory);
  const status = await statusFor(config);
  return status ? { ...status } : { state: "not_open" };
}

export async function closeSession(config: SshConfig): Promise<Record<string, unknown>> {
  const paths = sessionPaths(config);
  ensureSessionDirectory(paths.directory);
  const metadata = readSessionMetadata(paths.metadata);
  if (!metadata) return { closed: false, state: "not_open" };
  try {
    await requestSession(paths.socket, metadata.token, { method: "close" }, undefined, 3000);
  } catch {
    removeSessionFiles(paths);
  }
  return { closed: true, state: "closed" };
}
