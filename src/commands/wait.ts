import type { CommandContext } from "./types.js";

export async function runWait(
  context: CommandContext,
  jobId: string,
  timeoutSeconds: number,
  pollIntervalSeconds: number,
): Promise<Record<string, unknown>> {
  const result = await context.client.wait(jobId, timeoutSeconds, pollIntervalSeconds);
  const { user: _user, ...safeJob } = result.job;
  context.audit.write({
    action: "wait", ssh_user: context.sshUser, job_id: jobId,
    resources: { timeout_seconds: timeoutSeconds, poll_interval_seconds: pollIntervalSeconds },
    policy_decision: "allowed", result: "success", remote_exit_code: 0,
  });
  return { ok: true, terminal: result.terminal, timed_out: result.timed_out, job: safeJob };
}
