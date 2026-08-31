import type { CommandContext } from "./types.js";

export async function runHold(context: CommandContext, jobId: string): Promise<Record<string, unknown>> {
  await context.client.hold(jobId);
  context.audit.write({
    action: "hold", ssh_user: context.sshUser, job_id: jobId,
    policy_decision: "allowed", result: "success", remote_exit_code: 0,
  });
  return { ok: true, job_id: jobId, held: true };
}
