import type { SignalScope } from "../policy/validator.js";
import type { CommandContext } from "./types.js";

export async function runSignal(
  context: CommandContext,
  jobId: string,
  signal: string,
  scope: SignalScope,
): Promise<Record<string, unknown>> {
  await context.client.signal(jobId, signal, scope);
  context.audit.write({
    action: "signal", ssh_user: context.sshUser, job_id: jobId, resources: { signal, scope },
    policy_decision: "allowed", result: "success", remote_exit_code: 0,
  });
  return { ok: true, job_id: jobId, signalled: true, signal, scope };
}
