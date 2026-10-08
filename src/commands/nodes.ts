import type { CommandContext } from "./types.js";

export async function runNodes(context: CommandContext): Promise<Record<string, unknown>> {
  const nodes = await context.client.nodes();
  context.audit.write({ action: "nodes", ssh_user: context.sshUser, policy_decision: "allowed", result: "success", remote_exit_code: 0 });
  return { ok: true, nodes };
}
