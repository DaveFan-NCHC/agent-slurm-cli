import type { CommandContext } from "./types.js";

export async function runRelease(context: CommandContext, jobId: string): Promise<Record<string, unknown>> {
  await context.client.release(jobId);
  context.audit.write({
    action: "release", ssh_user: context.sshUser, job_id: jobId,
    policy_decision: "allowed", result: "success", remote_exit_code: 0,
  });
  return { ok: true, job_id: jobId, released: true };
}
