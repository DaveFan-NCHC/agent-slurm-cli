import type { CommandContext } from "./types.js";

export async function runClusterInfo(context: CommandContext): Promise<Record<string, unknown>> {
  const partitions = await context.client.clusterInfo();
  context.audit.write({ action: "cluster-info", ssh_user: context.sshUser, policy_decision: "allowed", result: "success", remote_exit_code: 0 });
  return { ok: true, partitions };
}
