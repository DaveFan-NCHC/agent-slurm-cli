import { AgentError, ExitCode } from "../errors/errors.js";
import type { JobSummary, OwnedJob } from "./types.js";

function rows(output: string): string[][] {
  return output.split(/\r?\n/).filter((line) => line.trim()).map((line) => line.split("|"));
}

export function parseQueueList(output: string): JobSummary[] {
  return rows(output).map((fields) => {
    if (fields.length !== 5) throw new AgentError("SLURM_QUERY_FAILED", "Unexpected squeue output.", ExitCode.SlurmFailure);
    return { job_id: fields[0]!, name: fields[1]!, partition: fields[2]!, state: fields[3]!, elapsed: fields[4]! };
  });
}

export function parseQueueJob(output: string): OwnedJob | undefined {
  const fields = rows(output)[0];
  if (!fields) return undefined;
  if (fields.length !== 6) throw new AgentError("SLURM_QUERY_FAILED", "Unexpected squeue output.", ExitCode.SlurmFailure);
  return { job_id: fields[0]!, user: fields[1]!, name: fields[2]!, partition: fields[3]!, state: fields[4]!, elapsed: fields[5]! };
}

export function parseAccountingJob(output: string, requestedId: string): OwnedJob | undefined {
  for (const fields of rows(output)) {
    if (fields.length !== 7) throw new AgentError("SLURM_QUERY_FAILED", "Unexpected sacct output.", ExitCode.SlurmFailure);
    if (fields[0] === requestedId) {
      return {
        job_id: fields[0]!, user: fields[1]!, name: fields[2]!, partition: fields[3]!,
        state: fields[4]!, elapsed: fields[5]!, exit_code: fields[6]!,
      };
    }
  }
  return undefined;
}

export function parseSubmittedJobId(output: string): string {
  const match = /^([1-9]\d*)(?:;[A-Za-z0-9_.-]+)?$/.exec(output.trim());
  if (!match) {
    throw new AgentError("SLURM_SUBMIT_FAILED", "sbatch returned an invalid job ID.", ExitCode.SlurmFailure);
  }
  return match[1]!;
}
