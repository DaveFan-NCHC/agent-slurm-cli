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
  | "SCRIPT_TOO_LARGE"
  | "SCRIPT_INVALID"
  | "SCRIPT_DIRECTIVES_NOT_ALLOWED"
  | "SCRIPT_UPLOAD_FAILED"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_OWNED_BY_USER"
  | "SLURM_SUBMIT_FAILED"
  | "SLURM_QUERY_FAILED"
  | "SLURM_CANCEL_FAILED"
  | "SLURM_CONTROL_FAILED"
  | "SLURM_LOG_FAILED"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_TOO_LARGE"
  | "ARTIFACT_ALREADY_EXISTS"
  | "ARTIFACT_DOWNLOAD_FAILED"
  | "ARTIFACT_LIST_TOO_LARGE"
  | "LOCAL_PATH_NOT_ALLOWED"
  | "RUNTIME_ALIAS_NOT_ALLOWED"
  | "GRES_ALIAS_NOT_ALLOWED"
  | "ACCOUNT_ALIAS_NOT_ALLOWED"
  | "QOS_ALIAS_NOT_ALLOWED"
  | "CONSTRAINT_ALIAS_NOT_ALLOWED"
  | "NODELIST_ALIAS_NOT_ALLOWED"
  | "EXCLUDE_NODELIST_ALIAS_NOT_ALLOWED"
  | "RESERVATION_ALIAS_NOT_ALLOWED"
  | "SIGNAL_NOT_ALLOWED"
  | "DEPENDENCY_TYPE_NOT_ALLOWED"
  | "RUNTIME_NOT_FOUND"
  | "RUNTIME_REQUIRED"
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
