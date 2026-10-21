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
    expect(config.remoteSrunPath).toBe("/usr/bin/srun");
    expect(config.remoteModulecmdPath).toBe("/usr/bin/modulecmd");
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

  it("accepts a controlled srun path and rejects unsafe values", () => {
    expect(loadConfig(environment({ SLURM_REMOTE_SRUN_PATH: "/opt/slurm/bin/srun" })).remoteSrunPath)
      .toBe("/opt/slurm/bin/srun");
    expect(() => loadConfig(environment({ SLURM_REMOTE_SRUN_PATH: "/usr/bin/srun;id" })))
      .toThrowError(/SLURM_REMOTE_SRUN_PATH must be a safe absolute POSIX path/);
  });

  it("accepts a controlled modulecmd path and rejects unsafe values", () => {
    expect(loadConfig(environment({ SLURM_REMOTE_MODULECMD_PATH: "/opt/lmod/libexec/lmod" })).remoteModulecmdPath)
      .toBe("/opt/lmod/libexec/lmod");
    expect(() => loadConfig(environment({ SLURM_REMOTE_MODULECMD_PATH: "/usr/bin/modulecmd;id" })))
      .toThrowError(/SLURM_REMOTE_MODULECMD_PATH must be a safe absolute POSIX path/);
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

describe("persistent SSH session configuration", () => {
  it("uses bounded session lifetime defaults", () => {
    const config = loadConfig(environment());
    expect(config.ssh.sessionIdleTimeoutMs).toBe(30 * 60 * 1000);
    expect(config.ssh.sessionMaxLifetimeMs).toBe(8 * 60 * 60 * 1000);
    expect(config.ssh.sessionDirectory).toMatch(/^\//);
  });

  it("accepts explicit session timeouts and an absolute runtime directory", () => {
    const config = loadConfig(environment({
      SLURM_SSH_SESSION_IDLE_TIMEOUT_MS: "60000",
      SLURM_SSH_SESSION_MAX_LIFETIME_MS: "120000",
      SLURM_SSH_SESSION_DIR: "/run/slurm-agent-test",
    }));
    expect(config.ssh).toMatchObject({
      sessionIdleTimeoutMs: 60000,
      sessionMaxLifetimeMs: 120000,
      sessionDirectory: "/run/slurm-agent-test",
    });
  });

  it("rejects invalid session lifetime configuration", () => {
    expect(() => loadConfig(environment({ SLURM_SSH_SESSION_IDLE_TIMEOUT_MS: "999" })))
      .toThrowError(/SLURM_SSH_SESSION_IDLE_TIMEOUT_MS must be between/);
    expect(() => loadConfig(environment({
      SLURM_SSH_SESSION_IDLE_TIMEOUT_MS: "120000",
      SLURM_SSH_SESSION_MAX_LIFETIME_MS: "60000",
    }))).toThrowError(/MAX_LIFETIME_MS must be greater than or equal/);
    expect(() => loadConfig(environment({ SLURM_SSH_SESSION_DIR: "relative/session" })))
      .toThrowError(/must be an absolute local path/);
  });
});

describe("SFTP endpoint configuration", () => {
  it("uses the SSH connection for transfers when no SFTP endpoint is configured", () => {
    const config = loadConfig(environment());
    expect(config.ssh.sftp).toBeUndefined();
  });

  it("configures a separate SFTP endpoint while inheriting SSH identity and authentication", () => {
    const config = loadConfig(environment({ SLURM_SFTP_PORT: "2222" }));
    expect(config.ssh.sftp).toMatchObject({
      host: "host",
      port: 2222,
      user: "alice",
      authentication: { type: "private-key" },
      knownHostsPath: config.ssh.knownHostsPath,
    });
  });

  it("accepts a separate SFTP host, user, and host fingerprint", () => {
    const config = loadConfig(environment({
      SLURM_SFTP_HOST: "transfer.example",
      SLURM_SFTP_PORT: "2222",
      SLURM_SFTP_USER: "transfer-alice",
      SLURM_SFTP_HOST_FINGERPRINT: "SHA256:sftp-key",
    }));
    expect(config.ssh.sftp).toMatchObject({
      host: "transfer.example",
      port: 2222,
      user: "transfer-alice",
      hostFingerprint: "SHA256:sftp-key",
    });
  });

  it("requires separate verification when only an SSH fingerprint covers a different SFTP endpoint", () => {
    expect(() => loadConfig(environment({
      SLURM_SSH_KNOWN_HOSTS: undefined,
      SLURM_SSH_HOST_FINGERPRINT: "SHA256:ssh-key",
      SLURM_SFTP_PORT: "2222",
    }))).toThrowError(/separately configured SFTP endpoint requires/);
  });

  it("rejects an invalid SFTP port", () => {
    expect(() => loadConfig(environment({ SLURM_SFTP_PORT: "0" })))
      .toThrowError(/SLURM_SFTP_PORT must be an integer from 1 to 65535/);
  });
});
