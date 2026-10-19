import type { Policy } from "../policy/types.js";
import type { CommandContext } from "./types.js";

export function runModules(context: CommandContext, policy: Policy): Record<string, unknown> {
  context.audit.write({
    action: "modules",
    ssh_user: context.sshUser,
    policy_decision: "allowed",
    result: "success",
  });
  return {
    ok: true,
    modules: Object.entries(policy.allowedModules).map(([alias, name]) => ({ alias, name })),
  };
}
