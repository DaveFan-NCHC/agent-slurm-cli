import type { CommandContext } from "./types.js";

export async function runLogs(
  context: CommandContext,
  jobId: string,
  stream: "stdout" | "stderr",
  lines: number,
): Promise<Record<string, unknown>> {
  const log = await context.client.logs(jobId, stream, lines);
  context.audit.write({ action: "logs", ssh_user: context.sshUser, job_id: jobId, resources: { stream, lines }, policy_decision: "allowed", result: "success", remote_exit_code: 0 });
  return { ok: true, ...log };
}
