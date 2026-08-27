import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { posix } from "node:path";
import { AgentError, ExitCode, policyDenied } from "../errors/errors.js";

const safeSegment = /^[A-Za-z0-9._-]+$/;

export function resolveWorkspacePath(workspace: string, userPath: string): string {
  if (!userPath || userPath.includes("\0") || userPath.includes("\\") || posix.isAbsolute(userPath)) {
    throw policyDenied("PATH_NOT_ALLOWED", "Path must be a non-empty workspace-relative POSIX path.");
  }
  const segments = userPath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || !safeSegment.test(segment))) {
    throw policyDenied("PATH_NOT_ALLOWED", "Path contains a forbidden segment or character.");
  }
  return `${workspace}/${segments.join("/")}`;
}

export function isContained(workspaceRealPath: string, targetRealPath: string): boolean {
  return targetRealPath === workspaceRealPath || targetRealPath.startsWith(`${workspaceRealPath}/`);
}

export function resolveLocalArtifactPath(basePath: string, jobId: string, artifactPath: string): string {
  if (!isAbsolute(basePath)) {
    throw new AgentError("LOCAL_PATH_NOT_ALLOWED", "SLURM_LOCAL_ARTIFACTS must be an absolute path.", ExitCode.General);
  }
  const safeRelative = resolveWorkspacePath("/artifact", artifactPath).slice("/artifact/".length);
  try {
    mkdirSync(basePath, { recursive: true, mode: 0o700 });
    const baseReal = realpathSync(basePath);
    const target = resolve(baseReal, jobId, safeRelative);
    const parent = dirname(target);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentReal = realpathSync(parent);
    if (!isContained(baseReal, parentReal)) {
      throw new AgentError("LOCAL_PATH_NOT_ALLOWED", "Local artifact path resolves outside SLURM_LOCAL_ARTIFACTS.", ExitCode.PolicyDenied);
    }
    const finalPath = resolve(parentReal, target.slice(parent.length + 1));
    if (existsSync(finalPath)) {
      throw new AgentError("ARTIFACT_ALREADY_EXISTS", "The local artifact already exists; overwriting is not permitted.", ExitCode.General);
    }
    return finalPath;
  } catch (cause) {
    if (cause instanceof AgentError) throw cause;
    throw new AgentError("LOCAL_PATH_NOT_ALLOWED", `Unable to prepare local artifact path: ${(cause as Error).message}`, ExitCode.General);
  }
}
