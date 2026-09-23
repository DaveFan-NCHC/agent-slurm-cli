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

describe("SSH authentication configuration", () => {
  it("uses private-key authentication by default", () => {
    const config = loadConfig(environment());
    expect(config.ssh.authentication).toMatchObject({ type: "private-key" });
  });

  it("accepts password authentication without a private key", () => {
    const config = loadConfig(environment({
      SLURM_SSH_KEY_PATH: undefined,
      SLURM_SSH_PASSWORD: " secret with spaces ",
    }));
    expect(config.ssh.authentication).toEqual({
      type: "password",
      password: " secret with spaces ",
    });
  });

  it("rejects configuring both a private key and a password", () => {
    expect(() => loadConfig(environment({ SLURM_SSH_PASSWORD: "secret" })))
      .toThrowError(/exactly one of SLURM_SSH_KEY_PATH or SLURM_SSH_PASSWORD/);
  });

  it("requires one supported SSH authentication method", () => {
    expect(() => loadConfig(environment({ SLURM_SSH_KEY_PATH: undefined })))
      .toThrowError(/SLURM_SSH_KEY_PATH or SLURM_SSH_PASSWORD is required/);
  });

  it("accepts keyboard-interactive PAM password authentication", () => {
    const config = loadConfig(environment({
      SLURM_SSH_KEY_PATH: undefined,
      SLURM_SSH_PASSWORD: "pam password",
      SLURM_SSH_PASSWORD_AUTH_METHOD: "keyboard-interactive",
    }));
    expect(config.ssh.authentication).toEqual({
      type: "keyboard-interactive-password",
      password: "pam password",
    });
  });

  it("rejects an unknown password authentication method", () => {
    expect(() => loadConfig(environment({
      SLURM_SSH_KEY_PATH: undefined,
      SLURM_SSH_PASSWORD: "secret",
      SLURM_SSH_PASSWORD_AUTH_METHOD: "auto",
    }))).toThrowError(/must be password or keyboard-interactive/);
  });

  it("rejects a password authentication method with private-key authentication", () => {
    expect(() => loadConfig(environment({ SLURM_SSH_PASSWORD_AUTH_METHOD: "keyboard-interactive" })))
      .toThrowError(/can be set only with SLURM_SSH_PASSWORD/);
  });

  it("enables automatic push authentication with a longer default authentication timeout", () => {
    const config = loadConfig(environment({ SLURM_SSH_PUSH_AUTH: "true" }));
    expect(config.ssh.pushAuthentication).toBe(true);
    expect(config.ssh.readyTimeoutMs).toBe(120000);
  });

  it("accepts a bounded custom SSH authentication timeout", () => {
    const config = loadConfig(environment({
      SLURM_SSH_PUSH_AUTH: "true",
      SLURM_SSH_AUTH_TIMEOUT_MS: "180000",
    }));
    expect(config.ssh.readyTimeoutMs).toBe(180000);
  });

  it.each([
    [{ SLURM_SSH_PUSH_AUTH: "yes" }, /SLURM_SSH_PUSH_AUTH must be true or false/],
    [{ SLURM_SSH_AUTH_TIMEOUT_MS: "999" }, /SLURM_SSH_AUTH_TIMEOUT_MS must be between/],
  ] as const)("rejects invalid push authentication configuration", (overrides, message) => {
    expect(() => loadConfig(environment(overrides))).toThrowError(message);
  });
});
