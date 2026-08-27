import type { CommandContext } from "./types.js";

export async function runArtifact(context: CommandContext, jobId: string, path: string): Promise<Record<string, unknown>> {
  const artifact = await context.client.artifact(jobId, path);
  context.audit.write({
    action: "artifact", ssh_user: context.sshUser, job_id: jobId, resources: { path },
    policy_decision: "allowed", result: "success", remote_exit_code: 0,
  });
  return { ok: true, artifact };
}
