import type { AuditLogger } from "../audit/logger.js";
import type { DiscoveryClient } from "../discovery/client.js";
import type { DiscoveryTarget } from "../discovery/types.js";

export async function runDiscover(
  client: DiscoveryClient,
  audit: AuditLogger,
  sshUser: string,
  target: DiscoveryTarget,
): Promise<Record<string, unknown>> {
  let discovery: Record<string, unknown>;
  switch (target) {
    case "cluster":
      discovery = await client.cluster();
      break;
    case "modules":
      discovery = await client.modules();
      break;
    case "associations":
      discovery = await client.associations();
      break;
    case "runtimes":
      discovery = await client.runtimes();
      break;
  }
  audit.write({
    action: `discover.${target}`,
    ssh_user: sshUser,
    policy_decision: "allowed",
    result: "success",
    remote_exit_code: 0,
  });
  return { ok: true, discovery: target, ...discovery };
}
