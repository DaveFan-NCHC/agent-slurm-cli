import { readFileSync } from "node:fs";
import { AgentError, ExitCode } from "../errors/errors.js";

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  authentication:
    | { type: "private-key"; keyPath: string }
    | { type: "password"; password: string }
    | { type: "keyboard-interactive-password"; password: string };
  knownHostsPath?: string;
  hostFingerprint?: string;
  workspace: string;
  timeoutMs: number;
  readyTimeoutMs: number;
  pushAuthentication: boolean;
}

export interface AppConfig {
  ssh: SshConfig;
  policyPath: string;
  auditLogPath?: string;
  localArtifactsPath?: string;
  localJobWorkspace?: string;
  remoteApptainerPath: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const portText = env.SLURM_SSH_PORT?.trim() || "22";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AgentError("CONFIGURATION_ERROR", "SLURM_SSH_PORT must be an integer from 1 to 65535.", ExitCode.General);
  }
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
  try {
    if (keyPath) readFileSync(keyPath);
    if (knownHostsPath) readFileSync(knownHostsPath);
  } catch (cause) {
    throw new AgentError("CONFIGURATION_ERROR", `SSH key or known_hosts file is not readable: ${(cause as Error).message}`, ExitCode.General);
  }
  const workspace = safeRemotePath(required(env, "SLURM_REMOTE_WORKSPACE"), "SLURM_REMOTE_WORKSPACE");
  return {
    ssh: {
      host: required(env, "SLURM_SSH_HOST"),
      port,
      user: required(env, "SLURM_SSH_USER"),
      authentication: keyPath
        ? { type: "private-key", keyPath }
        : passwordMethod === "keyboard-interactive"
          ? { type: "keyboard-interactive-password", password: password! }
          : { type: "password", password: password! },
      knownHostsPath,
      hostFingerprint,
      workspace,
      timeoutMs,
      readyTimeoutMs,
      pushAuthentication,
    },
    policyPath: env.SLURM_POLICY_PATH?.trim() || "./slurm-agent-policy.yaml",
    auditLogPath: env.SLURM_AUDIT_LOG?.trim() || undefined,
    localArtifactsPath: env.SLURM_LOCAL_ARTIFACTS?.trim() || undefined,
    localJobWorkspace: env.SLURM_LOCAL_JOB_WORKSPACE?.trim() || undefined,
    remoteApptainerPath: safeRemotePath(
      env.SLURM_REMOTE_APPTAINER_PATH?.trim() || "/usr/bin/apptainer",
      "SLURM_REMOTE_APPTAINER_PATH",
    ),
  };
}
