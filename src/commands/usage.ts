import type { CommandContext } from "./types.js";

export async function runUsage(context: CommandContext, jobId: string): Promise<Record<string, unknown>> {
  const usage = await context.client.usage(jobId);
  context.audit.write({
    action: "usage", ssh_user: context.sshUser, job_id: jobId,
    policy_decision: "allowed", result: "success", remote_exit_code: 0,
  });
  return { ok: true, usage };
}
