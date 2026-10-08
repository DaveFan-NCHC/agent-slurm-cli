import type { ListQuery } from "../slurm/types.js";
import type { CommandContext } from "./types.js";

export async function runList(context: CommandContext, query: ListQuery): Promise<Record<string, unknown>> {
  const jobs = await context.client.list(query);
  context.audit.write({
    action: "list", ssh_user: context.sshUser, resources: { ...query },
    policy_decision: "allowed", result: "success", remote_exit_code: 0,
  });
  return { ok: true, query, jobs };
}
