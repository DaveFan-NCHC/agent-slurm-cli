import type { CommandContext } from "./types.js";

export async function runHistory(
  context: CommandContext,
  days: number,
  state: string | undefined,
  limit: number,
): Promise<Record<string, unknown>> {
  const jobs = await context.client.history(days, state, limit);
  context.audit.write({
    action: "history", ssh_user: context.sshUser, resources: { days, state, limit },
    policy_decision: "allowed", result: "success", remote_exit_code: 0,
  });
  return { ok: true, query: { days, state, limit }, jobs };
}
