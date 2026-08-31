import type { CommandContext } from "./types.js";

export async function runArtifacts(context: CommandContext, jobId: string): Promise<Record<string, unknown>> {
  const artifacts = await context.client.artifacts(jobId);
  context.audit.write({
    action: "artifacts", ssh_user: context.sshUser, job_id: jobId,
    resources: { files: artifacts.length }, policy_decision: "allowed", result: "success", remote_exit_code: 0,
  });
  return { ok: true, job_id: jobId, artifacts };
}
