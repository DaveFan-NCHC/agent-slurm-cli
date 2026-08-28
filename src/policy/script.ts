import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { AgentError, ExitCode } from "../errors/errors.js";
import { isContained, resolveWorkspacePath } from "./path.js";
import type { Policy } from "./types.js";

export interface PreparedScript {
  content: Buffer;
  relativePath: string;
  sha256: string;
}

export function prepareLocalScript(localWorkspace: string | undefined, scriptPath: string, policy: Policy): PreparedScript {
  if (!localWorkspace || !isAbsolute(localWorkspace)) {
    throw new AgentError("CONFIGURATION_ERROR", "SLURM_LOCAL_JOB_WORKSPACE must be configured as an absolute path.", ExitCode.General);
  }
  let descriptor: number | undefined;
  try {
    const workspaceReal = realpathSync(localWorkspace);
    const relativePath = resolveWorkspacePath("/local", scriptPath).slice("/local/".length);
    const candidate = resolve(workspaceReal, relativePath);
    if (lstatSync(candidate).isSymbolicLink()) {
      throw new AgentError("LOCAL_PATH_NOT_ALLOWED", "Job script may not be a symbolic link.", ExitCode.PolicyDenied);
    }
    const targetReal = realpathSync(candidate);
    if (!isContained(workspaceReal, targetReal)) {
      throw new AgentError("LOCAL_PATH_NOT_ALLOWED", "Job script resolves outside SLURM_LOCAL_JOB_WORKSPACE.", ExitCode.PolicyDenied);
    }
    descriptor = openSync(targetReal, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedReal = realpathSync(`/proc/self/fd/${descriptor}`);
    if (!isContained(workspaceReal, openedReal)) {
      throw new AgentError("LOCAL_PATH_NOT_ALLOWED", "Opened job script is outside SLURM_LOCAL_JOB_WORKSPACE.", ExitCode.PolicyDenied);
    }
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new AgentError("SCRIPT_INVALID", "Job script must be a regular file.", ExitCode.InvalidArguments);
    if (stats.size > policy.maxScriptBytes) {
      throw new AgentError("SCRIPT_TOO_LARGE", `Job script exceeds policy maximum ${policy.maxScriptBytes} bytes.`, ExitCode.PolicyDenied);
    }
    const content = readFileSync(descriptor);
    if (content.length > policy.maxScriptBytes) {
      throw new AgentError("SCRIPT_TOO_LARGE", `Job script exceeds policy maximum ${policy.maxScriptBytes} bytes.`, ExitCode.PolicyDenied);
    }
    if (content.includes(0)) throw new AgentError("SCRIPT_INVALID", "Job script contains a NUL byte.", ExitCode.InvalidArguments);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); }
    catch { throw new AgentError("SCRIPT_INVALID", "Job script must be valid UTF-8.", ExitCode.InvalidArguments); }
    if (!text.startsWith("#!")) {
      throw new AgentError("SCRIPT_INVALID", "Job script must begin with a shebang.", ExitCode.InvalidArguments);
    }
    if (/^[\t ]*#SBATCH(?:[\t ]|$)/m.test(text)) {
      throw new AgentError(
        "SCRIPT_DIRECTIVES_NOT_ALLOWED",
        "Agent-generated scripts may not contain #SBATCH directives; use submit options instead.",
        ExitCode.PolicyDenied,
      );
    }
    return { content, relativePath, sha256: createHash("sha256").update(content).digest("hex") };
  } catch (cause) {
    if (cause instanceof AgentError) throw cause;
    throw new AgentError("LOCAL_PATH_NOT_ALLOWED", `Unable to read local job script: ${(cause as Error).message}`, ExitCode.General);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
