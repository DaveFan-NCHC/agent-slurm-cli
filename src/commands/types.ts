import type { AuditLogger } from "../audit/logger.js";
import type { SlurmClient } from "../slurm/client.js";

export interface CommandContext {
  client: SlurmClient;
  audit: AuditLogger;
  sshUser: string;
}
