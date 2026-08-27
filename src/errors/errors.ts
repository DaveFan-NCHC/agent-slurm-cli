export const ExitCode = {
  Success: 0,
  General: 1,
  InvalidArguments: 2,
  PolicyDenied: 3,
  SshFailure: 4,
  SlurmFailure: 5,
  NotFound: 6,
  PermissionDenied: 7,
} as const;

export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_JOB_ID"
  | "CONFIGURATION_ERROR"
  | "SSH_CONNECTION_FAILED"
  | "SSH_AUTH_FAILED"
  | "SSH_HOST_VERIFICATION_FAILED"
  | "PARTITION_NOT_ALLOWED"
  | "RESOURCE_LIMIT_EXCEEDED"
  | "TIME_LIMIT_EXCEEDED"
  | "PATH_NOT_ALLOWED"
  | "SCRIPT_NOT_FOUND"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED_BY_USER"
  | "SLURM_SUBMIT_FAILED"
  | "SLURM_QUERY_FAILED"
  | "SLURM_CANCEL_FAILED"
  | "SLURM_LOG_FAILED"
  | "REMOTE_COMMAND_TIMEOUT";

export class AgentError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly exitCode: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export function invalid(message: string, code: ErrorCode = "INVALID_ARGUMENT"): AgentError {
  return new AgentError(code, message, ExitCode.InvalidArguments);
}

export function policyDenied(code: ErrorCode, message: string): AgentError {
  return new AgentError(code, message, ExitCode.PolicyDenied);
}
