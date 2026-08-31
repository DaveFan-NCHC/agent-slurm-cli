import type { CommandContext } from "./types.js";

export async function runFairshare(context: CommandContext): Promise<Record<string, unknown>> {
  const fairshare = await context.client.fairshare();
  context.audit.write({
    action: "fairshare", ssh_user: context.sshUser,
    policy_decision: "allowed", result: "success", remote_exit_code: 0,
  });
  return { ok: true, fairshare };
}
