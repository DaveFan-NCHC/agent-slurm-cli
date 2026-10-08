import type { HistoryQuery } from "../slurm/types.js";
import type { CommandContext } from "./types.js";

export async function runHistory(
  context: CommandContext,
  query: HistoryQuery,
): Promise<Record<string, unknown>> {
  const jobs = await context.client.history(query);
  context.audit.write({
    action: "history", ssh_user: context.sshUser, resources: { ...query },
    policy_decision: "allowed", result: "success", remote_exit_code: 0,
  });
  return { ok: true, query, jobs };
}
