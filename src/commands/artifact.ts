import type { CommandContext } from "./types.js";

export async function runArtifact(
  context: CommandContext,
  jobId: string,
  path: string,
  force = false,
): Promise<Record<string, unknown>> {
  const artifact = await context.client.artifact(jobId, path, force);
  context.audit.write({
    action: "artifact", ssh_user: context.sshUser, job_id: jobId,
    resources: { path, force, bytes: artifact.bytes, sha256: artifact.sha256, overwritten: artifact.overwritten },
    policy_decision: "allowed", result: "success", remote_exit_code: 0,
  });
  return { ok: true, artifact };
}
