import { readFileSync } from "node:fs";
import { AgentError, ExitCode } from "../errors/errors.js";

export interface SshConnectionConfig {
  host: string;
  port: number;
  user: string;
  authentication:
    | { type: "private-key"; keyPath: string }
    | { type: "password"; password: string }
    | { type: "keyboard-interactive-password"; password: string };
  knownHostsPath?: string;
  hostFingerprint?: string;
  readyTimeoutMs: number;
  pushAuthentication: boolean;
}

export interface SshConfig extends SshConnectionConfig {
  workspace: string;
  timeoutMs: number;
  sftp?: SshConnectionConfig;
}

export interface AppConfig {
  ssh: SshConfig;
  policyPath: string;
  auditLogPath?: string;
  localArtifactsPath?: string;
  localJobWorkspace?: string;
  remoteApptainerPath: string;
  remoteSrunPath: string;
  remoteModulecmdPath: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new AgentError("CONFIGURATION_ERROR", `${name} is required.`, ExitCode.General);
  return value;
}

function safeRemotePath(value: string, name: string): string {
  const normalized = value.replace(/\/+$/, "");
  if (!/^\/[A-Za-z0-9_./+-]+$/.test(normalized) || normalized.split("/").includes("..")) {
    throw new AgentError("CONFIGURATION_ERROR", `${name} must be a safe absolute POSIX path.`, ExitCode.General);
  }
  return normalized;
}

function port(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value?.trim() || String(fallback));
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new AgentError("CONFIGURATION_ERROR", `${name} must be an integer from 1 to 65535.`, ExitCode.General);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = required(env, "SLURM_SSH_HOST");
  const sshPort = port(env.SLURM_SSH_PORT, 22, "SLURM_SSH_PORT");
  const user = required(env, "SLURM_SSH_USER");
  const timeoutText = env.SLURM_COMMAND_TIMEOUT_MS?.trim() || "30000";
  const timeoutMs = Number(timeoutText);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    throw new AgentError("CONFIGURATION_ERROR", "SLURM_COMMAND_TIMEOUT_MS must be between 1000 and 600000.", ExitCode.General);
  }
  const pushText = env.SLURM_SSH_PUSH_AUTH?.trim().toLowerCase();
  if (pushText !== undefined && pushText !== "true" && pushText !== "false") {
    throw new AgentError("CONFIGURATION_ERROR", "SLURM_SSH_PUSH_AUTH must be true or false.", ExitCode.General);
  }
  const pushAuthentication = pushText === "true";
  const readyTimeoutText = env.SLURM_SSH_AUTH_TIMEOUT_MS?.trim()
    || (pushAuthentication ? "120000" : String(timeoutMs));
  const readyTimeoutMs = Number(readyTimeoutText);
  if (!Number.isInteger(readyTimeoutMs) || readyTimeoutMs < 1000 || readyTimeoutMs > 600000) {
    throw new AgentError("CONFIGURATION_ERROR", "SLURM_SSH_AUTH_TIMEOUT_MS must be between 1000 and 600000.", ExitCode.General);
  }
  const knownHostsPath = env.SLURM_SSH_KNOWN_HOSTS?.trim();
  const hostFingerprint = env.SLURM_SSH_HOST_FINGERPRINT?.trim();
  if (!knownHostsPath && !hostFingerprint) {
    throw new AgentError(
      "CONFIGURATION_ERROR",
      "SLURM_SSH_KNOWN_HOSTS or SLURM_SSH_HOST_FINGERPRINT is required; insecure host verification is not supported.",
      ExitCode.General,
    );
  }
  const keyPath = env.SLURM_SSH_KEY_PATH?.trim();
  const password = env.SLURM_SSH_PASSWORD;
  const hasPassword = password !== undefined && password.length > 0;
  const passwordMethodValue = env.SLURM_SSH_PASSWORD_AUTH_METHOD?.trim().toLowerCase();
  const passwordMethod = passwordMethodValue || "password";
  if (passwordMethod !== "password" && passwordMethod !== "keyboard-interactive") {
    throw new AgentError(
      "CONFIGURATION_ERROR",
      "SLURM_SSH_PASSWORD_AUTH_METHOD must be password or keyboard-interactive.",
      ExitCode.General,
    );
  }
  if (keyPath && passwordMethodValue) {
    throw new AgentError(
      "CONFIGURATION_ERROR",
      "SLURM_SSH_PASSWORD_AUTH_METHOD can be set only with SLURM_SSH_PASSWORD.",
      ExitCode.General,
    );
  }
  if (keyPath && hasPassword) {
    throw new AgentError(
      "CONFIGURATION_ERROR",
      "Set exactly one of SLURM_SSH_KEY_PATH or SLURM_SSH_PASSWORD, not both.",
      ExitCode.General,
    );
  }
  if (!keyPath && !hasPassword) {
    throw new AgentError(
      "CONFIGURATION_ERROR",
      "SLURM_SSH_KEY_PATH or SLURM_SSH_PASSWORD is required.",
      ExitCode.General,
    );
  }
  const authentication: SshConnectionConfig["authentication"] = keyPath
    ? { type: "private-key", keyPath }
    : passwordMethod === "keyboard-interactive"
      ? { type: "keyboard-interactive-password", password: password! }
      : { type: "password", password: password! };
  const hasSftpConfiguration = [
    "SLURM_SFTP_HOST",
    "SLURM_SFTP_PORT",
    "SLURM_SFTP_USER",
    "SLURM_SFTP_KNOWN_HOSTS",
    "SLURM_SFTP_HOST_FINGERPRINT",
  ].some((name) => Boolean(env[name]?.trim()));
  let sftp: SshConnectionConfig | undefined;
  if (hasSftpConfiguration) {
    const sftpHost = env.SLURM_SFTP_HOST?.trim() || host;
    const sftpPort = port(env.SLURM_SFTP_PORT, sshPort, "SLURM_SFTP_PORT");
    const sftpKnownHostsPath = env.SLURM_SFTP_KNOWN_HOSTS?.trim() || knownHostsPath;
    const explicitSftpFingerprint = env.SLURM_SFTP_HOST_FINGERPRINT?.trim();
    const sameEndpoint = sftpHost === host && sftpPort === sshPort;
    const sftpHostFingerprint = explicitSftpFingerprint || (sameEndpoint ? hostFingerprint : undefined);
    if (!sftpKnownHostsPath && !sftpHostFingerprint) {
      throw new AgentError(
        "CONFIGURATION_ERROR",
        "A separately configured SFTP endpoint requires SLURM_SFTP_KNOWN_HOSTS or SLURM_SFTP_HOST_FINGERPRINT; SLURM_SSH_KNOWN_HOSTS may also contain its host key.",
        ExitCode.General,
      );
    }
    sftp = {
      host: sftpHost,
      port: sftpPort,
      user: env.SLURM_SFTP_USER?.trim() || user,
      authentication,
      knownHostsPath: sftpKnownHostsPath,
      hostFingerprint: sftpHostFingerprint,
      readyTimeoutMs,
      pushAuthentication,
    };
  }
  try {
    if (keyPath) readFileSync(keyPath);
    if (knownHostsPath) readFileSync(knownHostsPath);
    if (sftp?.knownHostsPath && sftp.knownHostsPath !== knownHostsPath) readFileSync(sftp.knownHostsPath);
  } catch (cause) {
    throw new AgentError("CONFIGURATION_ERROR", `SSH/SFTP key or known_hosts file is not readable: ${(cause as Error).message}`, ExitCode.General);
  }
  const workspace = safeRemotePath(required(env, "SLURM_REMOTE_WORKSPACE"), "SLURM_REMOTE_WORKSPACE");
  return {
    ssh: {
      host,
      port: sshPort,
      user,
      authentication,
      knownHostsPath,
      hostFingerprint,
      workspace,
      timeoutMs,
      readyTimeoutMs,
      pushAuthentication,
      sftp,
    },
    policyPath: env.SLURM_POLICY_PATH?.trim() || "./slurm-agent-policy.yaml",
    auditLogPath: env.SLURM_AUDIT_LOG?.trim() || undefined,
    localArtifactsPath: env.SLURM_LOCAL_ARTIFACTS?.trim() || undefined,
    localJobWorkspace: env.SLURM_LOCAL_JOB_WORKSPACE?.trim() || undefined,
    remoteApptainerPath: safeRemotePath(
      env.SLURM_REMOTE_APPTAINER_PATH?.trim() || "/usr/bin/apptainer",
      "SLURM_REMOTE_APPTAINER_PATH",
    ),
    remoteSrunPath: safeRemotePath(
      env.SLURM_REMOTE_SRUN_PATH?.trim() || "/usr/bin/srun",
      "SLURM_REMOTE_SRUN_PATH",
    ),
    remoteModulecmdPath: safeRemotePath(
      env.SLURM_REMOTE_MODULECMD_PATH?.trim() || "/usr/bin/modulecmd",
      "SLURM_REMOTE_MODULECMD_PATH",
    ),
  };
}
