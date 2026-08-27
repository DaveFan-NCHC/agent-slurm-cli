import { readFileSync } from "node:fs";
import { AgentError, ExitCode } from "../errors/errors.js";

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  keyPath: string;
  knownHostsPath?: string;
  hostFingerprint?: string;
  workspace: string;
  timeoutMs: number;
}

export interface AppConfig {
  ssh: SshConfig;
  policyPath: string;
  auditLogPath?: string;
  localArtifactsPath?: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new AgentError("CONFIGURATION_ERROR", `${name} is required.`, ExitCode.General);
  return value;
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
  const knownHostsPath = env.SLURM_SSH_KNOWN_HOSTS?.trim();
  const hostFingerprint = env.SLURM_SSH_HOST_FINGERPRINT?.trim();
  if (!knownHostsPath && !hostFingerprint) {
    throw new AgentError(
      "CONFIGURATION_ERROR",
      "SLURM_SSH_KNOWN_HOSTS or SLURM_SSH_HOST_FINGERPRINT is required; insecure host verification is not supported.",
      ExitCode.General,
    );
  }
  const keyPath = required(env, "SLURM_SSH_KEY_PATH");
  try {
    readFileSync(keyPath);
    if (knownHostsPath) readFileSync(knownHostsPath);
  } catch (cause) {
    throw new AgentError("CONFIGURATION_ERROR", `SSH credential or known_hosts file is not readable: ${(cause as Error).message}`, ExitCode.General);
  }
  const workspace = required(env, "SLURM_REMOTE_WORKSPACE").replace(/\/+$/, "");
  if (!workspace.startsWith("/") || workspace === "") {
    throw new AgentError("CONFIGURATION_ERROR", "SLURM_REMOTE_WORKSPACE must be an absolute path.", ExitCode.General);
  }
  return {
    ssh: {
      host: required(env, "SLURM_SSH_HOST"),
      port,
      user: required(env, "SLURM_SSH_USER"),
      keyPath,
      knownHostsPath,
      hostFingerprint,
      workspace,
      timeoutMs,
    },
    policyPath: env.SLURM_POLICY_PATH?.trim() || "./slurm-agent-policy.yaml",
    auditLogPath: env.SLURM_AUDIT_LOG?.trim() || undefined,
    localArtifactsPath: env.SLURM_LOCAL_ARTIFACTS?.trim() || undefined,
  };
}
