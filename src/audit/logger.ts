import { appendFileSync } from "node:fs";

export interface AuditEvent {
  action: string;
  ssh_user?: string;
  job_id?: string;
  resources?: Record<string, unknown>;
  policy_decision: "allowed" | "denied";
  result: "success" | "failure";
  error_code?: string;
  remote_exit_code?: number;
}

export class AuditLogger {
  constructor(private readonly path: string | undefined, private readonly stderr: NodeJS.WritableStream = process.stderr) {}

  write(event: AuditEvent): void {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
    if (!this.path) { this.stderr.write(`${line}\n`); return; }
    try {
      appendFileSync(this.path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      this.stderr.write(`${JSON.stringify({
        timestamp: new Date().toISOString(), action: "audit_log_failure",
        policy_decision: "denied", result: "failure",
      })}\n`);
    }
  }
}
