import type { CommandContext } from "./types.js";

export async function runCancel(context: CommandContext, jobId: string): Promise<Record<string, unknown>> {
  await context.client.cancel(jobId);
  context.audit.write({ action: "cancel", ssh_user: context.sshUser, job_id: jobId, policy_decision: "allowed", result: "success", remote_exit_code: 0 });
  return { ok: true, job_id: jobId, cancelled: true };
}
