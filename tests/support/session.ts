import { writeFileSync } from "node:fs";
import type { Server } from "node:net";
import type { SshConfig } from "../../src/config/loader.js";
import { sessionPaths } from "../../src/session/paths.js";

export const sessionToken = "t".repeat(64);

export function sessionConfig(directory: string, host = "login.example"): SshConfig {
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

export function writeSessionMetadata(config: SshConfig, token = sessionToken): void {
  writeFileSync(sessionPaths(config).metadata, JSON.stringify({
    version: 1,
    pid: process.pid,
    token,
    createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
}

export async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
