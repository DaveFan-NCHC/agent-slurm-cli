import type { CommandContext } from "./types.js";

export async function runList(context: CommandContext): Promise<Record<string, unknown>> {
  const jobs = await context.client.list();
  context.audit.write({ action: "list", ssh_user: context.sshUser, policy_decision: "allowed", result: "success", remote_exit_code: 0 });
  return { ok: true, jobs };
}
