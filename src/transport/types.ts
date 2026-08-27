export type RemoteExecutable = "realpath" | "test" | "mkdir" | "sbatch" | "squeue" | "sacct" | "scancel" | "tail";

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

export interface RemoteExecutor {
  run(command: SafeCommand): Promise<RemoteResult>;
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
