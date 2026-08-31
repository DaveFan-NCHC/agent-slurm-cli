import type { NormalizedUpdate } from "../policy/validator.js";
import type { CommandContext } from "./types.js";

export async function runUpdate(
  context: CommandContext,
  jobId: string,
  options: NormalizedUpdate,
): Promise<Record<string, unknown>> {
  await context.client.update(jobId, options);
  const updated = {
    time: options.time,
    dependency: options.dependency,
    array_concurrency: options.arrayConcurrency,
  };
  context.audit.write({
    action: "update", ssh_user: context.sshUser, job_id: jobId, resources: updated,
    policy_decision: "allowed", result: "success", remote_exit_code: 0,
  });
  return { ok: true, job_id: jobId, updated };
}
