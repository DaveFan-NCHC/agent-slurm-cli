import type { CommandContext } from "./types.js";

export async function runDiagnose(context: CommandContext, jobId: string): Promise<Record<string, unknown>> {
  const diagnosis = await context.client.diagnose(jobId);
  context.audit.write({
    action: "diagnose", ssh_user: context.sshUser, job_id: jobId,
    resources: { findings: diagnosis.findings.map((finding) => finding.code) },
    policy_decision: "allowed", result: "success", remote_exit_code: 0,
  });
  return { ok: true, ...diagnosis };
}
