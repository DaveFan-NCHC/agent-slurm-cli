import type { CommandContext } from "./types.js";

export async function runStatus(context: CommandContext, jobId: string): Promise<Record<string, unknown>> {
  const job = await context.client.getOwnedJob(jobId);
  const { user: _user, ...safeJob } = job;
  context.audit.write({ action: "status", ssh_user: context.sshUser, job_id: jobId, policy_decision: "allowed", result: "success", remote_exit_code: 0 });
  return { ok: true, job: safeJob };
}
