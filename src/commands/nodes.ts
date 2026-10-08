import type { NodeQuery } from "../slurm/types.js";
import type { CommandContext } from "./types.js";

export async function runNodes(context: CommandContext, query: NodeQuery): Promise<Record<string, unknown>> {
  const nodes = await context.client.nodes(query);
  context.audit.write({
    action: "nodes", ssh_user: context.sshUser, resources: { ...query },
    policy_decision: "allowed", result: "success", remote_exit_code: 0,
  });
  return { ok: true, query, nodes };
}
