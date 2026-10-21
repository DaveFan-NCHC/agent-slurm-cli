import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { requestSession } from "../../src/session/client.js";
import { readSessionMetadata, sessionPaths } from "../../src/session/paths.js";
import { sessionConfig, waitFor } from "../support/session.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const fixture = fileURLToPath(new URL("../fixtures/session-worker.ts", import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("persistent session worker process", () => {
  it("serves authenticated RPC over a real child-process Unix socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-session-process-"));
    roots.push(root);
    const config = sessionConfig(root);
    const paths = sessionPaths(config);
    const child = spawn(process.execPath, [tsxCli, fixture], {
      env: {
        ...process.env,
        SLURM_SSH_HOST: config.host,
        SLURM_SSH_USER: config.user,
        SLURM_SSH_PASSWORD: "secret",
        SLURM_SSH_HOST_FINGERPRINT: config.hostFingerprint,
        SLURM_REMOTE_WORKSPACE: config.workspace,
        SLURM_SSH_SESSION_DIR: root,
        SLURM_SSH_SESSION_IDLE_TIMEOUT_MS: "60000",
        SLURM_SSH_SESSION_MAX_LIFETIME_MS: "60000",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });

    await waitFor(() => existsSync(paths.metadata), 3000);
    const metadata = readSessionMetadata(paths.metadata);
    expect(metadata, stderr).toBeDefined();
    await expect(requestSession(paths.socket, metadata!.token, { method: "open" }, undefined, 1000))
      .resolves.toMatchObject({ state: "ready" });
    await expect(requestSession(paths.socket, metadata!.token, {
      method: "run", command: { executable: "squeue", args: [] },
    }, undefined, 1000)).resolves.toEqual({ stdout: "squeue\n", stderr: "", exitCode: 0 });
    await expect(requestSession(paths.socket, metadata!.token, { method: "close" }, undefined, 1000))
      .resolves.toEqual({ closed: true });
    await waitFor(() => child.exitCode !== null, 3000);
    expect(child.exitCode, stderr).toBe(0);
  });
});
