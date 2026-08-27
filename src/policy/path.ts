import { posix } from "node:path";
import { policyDenied } from "../errors/errors.js";

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
