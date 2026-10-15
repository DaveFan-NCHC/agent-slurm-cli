export type RemoteExecutable = "realpath" | "test" | "mkdir" | "rm" | "find" | "sha256sum" | "sbatch" | "squeue" | "sacct" | "scancel" | "scontrol" | "sinfo" | "sprio" | "sshare" | "sstat" | "tail";

export interface SafeCommand {
  executable: RemoteExecutable;
  args: readonly string[];
  maxOutputBytes?: number;
}

export interface RemoteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface SafeArtifactTransfer {
  remotePath: string;
  localPath: string;
  maxBytes: number;
  overwrite?: boolean;
}

export interface SafeArtifactBundleTransfer {
  remoteDirectory: string;
  remoteArchivePath: string;
  localPath: string;
  maxBytes: number;
  prefix?: string;
  overwrite?: boolean;
}

export interface ArtifactDownload {
  bytes: number;
  sha256: string;
  overwritten: boolean;
}

export interface SafeSubmissionUpload {
  content: Buffer;
  remotePath: string;
  maxBytes: number;
  mode?: 0o600 | 0o700;
  label?: "payload" | "runner" | "input" | "manifest";
}

export interface RemoteExecutor {
  run(command: SafeCommand): Promise<RemoteResult>;
  downloadArtifact(transfer: SafeArtifactTransfer): Promise<ArtifactDownload>;
  downloadArtifactBundle(transfer: SafeArtifactBundleTransfer): Promise<ArtifactDownload>;
  uploadSubmission(upload: SafeSubmissionUpload): Promise<{ bytes: number }>;
  close(): Promise<void>;
}

export function shellEscape(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("Remote argument contains a forbidden control character.");
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function renderCommand(command: SafeCommand): string {
  return [shellEscape(command.executable), ...command.args.map(shellEscape)].join(" ");
}
