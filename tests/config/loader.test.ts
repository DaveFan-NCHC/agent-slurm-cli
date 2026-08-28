import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/loader.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), "slurm-agent-config-"));
  roots.push(root);
  const key = join(root, "key");
  const knownHosts = join(root, "known_hosts");
  writeFileSync(key, "test-key");
  writeFileSync(knownHosts, "host ssh-ed25519 AAAA\n");
  return {
    SLURM_SSH_HOST: "host",
    SLURM_SSH_USER: "alice",
    SLURM_SSH_KEY_PATH: key,
    SLURM_SSH_KNOWN_HOSTS: knownHosts,
    SLURM_REMOTE_WORKSPACE: "/home/alice/work-space",
    ...overrides,
  };
}

describe("configuration path safety", () => {
  it("accepts safe remote paths and trims a trailing slash", () => {
    const config = loadConfig(environment({ SLURM_REMOTE_WORKSPACE: "/home/alice/work-space/" }));
    expect(config.ssh.workspace).toBe("/home/alice/work-space");
    expect(config.remoteApptainerPath).toBe("/usr/bin/apptainer");
  });

  it.each(["/home/alice/work,ALL", "/home/alice/work space", "/home/alice/../root"])(
    "rejects unsafe remote workspace %j",
    (workspace) => {
      expect(() => loadConfig(environment({ SLURM_REMOTE_WORKSPACE: workspace })))
        .toThrowError(/SLURM_REMOTE_WORKSPACE must be a safe absolute POSIX path/);
    },
  );

  it("rejects an unsafe Apptainer executable path", () => {
    expect(() => loadConfig(environment({ SLURM_REMOTE_APPTAINER_PATH: "/usr/bin/app,tainer" })))
      .toThrowError(/SLURM_REMOTE_APPTAINER_PATH must be a safe absolute POSIX path/);
  });
});
