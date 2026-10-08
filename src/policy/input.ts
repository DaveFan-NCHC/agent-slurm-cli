import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AgentError, ExitCode } from "../errors/errors.js";
import { isContained, resolveWorkspacePath } from "./path.js";
import type { Policy } from "./types.js";

export interface PreparedInput {
  content: Buffer;
  relativePath: string;
  bytes: number;
  sha256: string;
}

export interface PreparedInputBundle {
  files: PreparedInput[];
  totalBytes: number;
  manifest: Buffer;
  manifestSha256: string;
}

function localInputPath(path: string): string {
  try {
    return resolveWorkspacePath("/local", path).slice("/local/".length);
  } catch {
    throw new AgentError(
      "LOCAL_PATH_NOT_ALLOWED",
      "Input paths must be safe workspace-relative POSIX paths.",
      ExitCode.PolicyDenied,
    );
  }
}

function prepareInput(workspaceReal: string, relativePath: string, policy: Policy): PreparedInput {
  let descriptor: number | undefined;
  try {
    let candidate = workspaceReal;
    for (const segment of relativePath.split("/")) {
      candidate = join(candidate, segment);
      if (lstatSync(candidate).isSymbolicLink()) {
        throw new AgentError("LOCAL_PATH_NOT_ALLOWED", "Input paths may not contain symbolic links.", ExitCode.PolicyDenied);
      }
    }
    const initial = lstatSync(candidate);
    if (!initial.isFile()) {
      throw new AgentError("INPUT_INVALID", "Each input must be a regular file.", ExitCode.InvalidArguments);
    }
    if (initial.nlink !== 1) {
      throw new AgentError("LOCAL_PATH_NOT_ALLOWED", "Hard-linked inputs are not permitted.", ExitCode.PolicyDenied);
    }
    const targetReal = realpathSync(candidate);
    if (!isContained(workspaceReal, targetReal)) {
      throw new AgentError("LOCAL_PATH_NOT_ALLOWED", "Input resolves outside SLURM_LOCAL_JOB_WORKSPACE.", ExitCode.PolicyDenied);
    }
    descriptor = openSync(targetReal, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedReal = realpathSync(`/proc/self/fd/${descriptor}`);
    const stats = fstatSync(descriptor);
    if (!isContained(workspaceReal, openedReal) || stats.dev !== initial.dev || stats.ino !== initial.ino) {
      throw new AgentError("LOCAL_PATH_NOT_ALLOWED", "Input changed while it was being opened.", ExitCode.PolicyDenied);
    }
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new AgentError("INPUT_INVALID", "Each input must remain a unique regular file.", ExitCode.InvalidArguments);
    }
    if (stats.size > policy.maxInputFileBytes) {
      throw new AgentError(
        "INPUT_TOO_LARGE",
        `An input exceeds policy maximum ${policy.maxInputFileBytes} bytes.`,
        ExitCode.PolicyDenied,
      );
    }
    const content = readFileSync(descriptor);
    if (content.length > policy.maxInputFileBytes) {
      throw new AgentError(
        "INPUT_TOO_LARGE",
        `An input exceeds policy maximum ${policy.maxInputFileBytes} bytes.`,
        ExitCode.PolicyDenied,
      );
    }
    return {
      content,
      relativePath,
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  } catch (cause) {
    if (cause instanceof AgentError) throw cause;
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgentError("INPUT_NOT_FOUND", "An input file was not found.", ExitCode.NotFound);
    }
    throw new AgentError("LOCAL_PATH_NOT_ALLOWED", `Unable to read input: ${(cause as Error).message}`, ExitCode.General);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function prepareInputBundle(
  localWorkspace: string | undefined,
  inputPaths: string[],
  policy: Policy,
): PreparedInputBundle {
  if (inputPaths.length > policy.maxInputFiles) {
    throw new AgentError(
      "INPUT_BUNDLE_TOO_LARGE",
      `Input count exceeds policy maximum ${policy.maxInputFiles}.`,
      ExitCode.PolicyDenied,
    );
  }
  if (inputPaths.length > 0 && (!localWorkspace || !isAbsolute(localWorkspace))) {
    throw new AgentError(
      "CONFIGURATION_ERROR",
      "SLURM_LOCAL_JOB_WORKSPACE must be configured as an absolute path when inputs are used.",
      ExitCode.General,
    );
  }
  let workspaceReal = localWorkspace;
  if (inputPaths.length > 0) {
    try { workspaceReal = realpathSync(localWorkspace!); }
    catch (cause) {
      throw new AgentError(
        "CONFIGURATION_ERROR",
        `Unable to resolve SLURM_LOCAL_JOB_WORKSPACE: ${(cause as Error).message}`,
        ExitCode.General,
      );
    }
  }
  const relativePaths = inputPaths.map(localInputPath);
  if (new Set(relativePaths).size !== relativePaths.length) {
    throw new AgentError("INPUT_INVALID", "Input destinations must be unique.", ExitCode.InvalidArguments);
  }
  const files: PreparedInput[] = [];
  let totalBytes = 0;
  for (const relativePath of relativePaths.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
    const input = prepareInput(workspaceReal!, relativePath, policy);
    totalBytes += input.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > policy.maxInputTotalBytes) {
      throw new AgentError(
        "INPUT_BUNDLE_TOO_LARGE",
        `Input bytes exceed policy maximum ${policy.maxInputTotalBytes}.`,
        ExitCode.PolicyDenied,
      );
    }
    files.push(input);
  }
  const manifest = Buffer.from(`${JSON.stringify({
    version: 1,
    files: files.map(({ relativePath: path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  })}\n`, "utf8");
  return {
    files,
    totalBytes,
    manifest,
    manifestSha256: createHash("sha256").update(manifest).digest("hex"),
  };
}
