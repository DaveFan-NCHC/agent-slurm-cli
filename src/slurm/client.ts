import { AgentError, ExitCode } from "../errors/errors.js";
import { isContained, resolveWorkspacePath } from "../policy/path.js";
import type { NormalizedSubmit } from "../policy/validator.js";
import type { Policy } from "../policy/types.js";
import type { RemoteExecutor, RemoteResult, SafeCommand } from "../transport/types.js";
import { parseAccountingJob, parseQueueJob, parseQueueList, parseSubmittedJobId } from "./parser.js";
import type { JobSummary, LogResult, OwnedJob } from "./types.js";

function failure(result: RemoteResult, code: "SLURM_SUBMIT_FAILED" | "SLURM_QUERY_FAILED" | "SLURM_CANCEL_FAILED" | "SLURM_LOG_FAILED", message: string): never {
  throw new AgentError(code, message, ExitCode.SlurmFailure, { remote_exit_code: result.exitCode });
}

export class SlurmClient {
  constructor(
    private readonly executor: RemoteExecutor,
    private readonly user: string,
    private readonly workspace: string,
    private readonly policy: Policy,
  ) {}

  private async run(command: SafeCommand): Promise<RemoteResult> { return this.executor.run(command); }

  private async realpath(path: string, mustExist = true): Promise<string | undefined> {
    const result = await this.run({ executable: "realpath", args: [mustExist ? "-e" : "-m", "--", path] });
    if (result.exitCode !== 0) return undefined;
    return result.stdout.trim();
  }

  private async workspaceRealpath(): Promise<string> {
    const path = await this.realpath(this.workspace);
    if (!path) throw new AgentError("PATH_NOT_ALLOWED", "Remote workspace does not exist.", ExitCode.PolicyDenied);
    return path;
  }

  async list(): Promise<JobSummary[]> {
    const result = await this.run({ executable: "squeue", args: ["--noheader", "--user", this.user, "--format=%i|%j|%P|%T|%M"] });
    if (result.exitCode !== 0) failure(result, "SLURM_QUERY_FAILED", "Unable to list Slurm jobs.");
    return parseQueueList(result.stdout);
  }

  async getOwnedJob(jobId: string): Promise<OwnedJob> {
    const active = await this.run({ executable: "squeue", args: ["--noheader", "--jobs", jobId, "--format=%i|%u|%j|%P|%T|%M"] });
    if (active.exitCode === 0) {
      const job = parseQueueJob(active.stdout);
      if (job) return this.assertOwner(job);
    }
    const accounting = await this.run({
      executable: "sacct",
      args: ["--noheader", "--parsable2", "--allocations", "--jobs", jobId, "--format=JobIDRaw,User,JobName,Partition,State,Elapsed,ExitCode"],
    });
    if (accounting.exitCode !== 0) failure(accounting, "SLURM_QUERY_FAILED", "Unable to query Slurm accounting.");
    const job = parseAccountingJob(accounting.stdout, jobId);
    if (!job) throw new AgentError("JOB_NOT_FOUND", `Job ${jobId} was not found.`, ExitCode.NotFound);
    return this.assertOwner(job);
  }

  private assertOwner(job: OwnedJob): OwnedJob {
    if (job.user !== this.user) {
      throw new AgentError("JOB_NOT_OWNED_BY_USER", `Job ${job.job_id} does not belong to the configured SSH user.`, ExitCode.PermissionDenied);
    }
    return job;
  }

  async submit(options: NormalizedSubmit): Promise<string> {
    const requested = resolveWorkspacePath(this.workspace, options.script);
    const [workspaceReal, scriptReal] = await Promise.all([this.workspaceRealpath(), this.realpath(requested)]);
    if (!scriptReal) throw new AgentError("SCRIPT_NOT_FOUND", "Script does not exist in the remote workspace.", ExitCode.PolicyDenied);
    if (!isContained(workspaceReal, scriptReal)) {
      throw new AgentError("PATH_NOT_ALLOWED", "Script resolves outside the remote workspace.", ExitCode.PolicyDenied);
    }
    const file = await this.run({ executable: "test", args: ["-f", "--", scriptReal] });
    if (file.exitCode !== 0) throw new AgentError("SCRIPT_NOT_FOUND", "Script is not a regular file.", ExitCode.PolicyDenied);
    const logDirectory = `${workspaceReal}/.slurm-agent/logs`;
    const mkdir = await this.run({ executable: "mkdir", args: ["-p", "--", logDirectory] });
    if (mkdir.exitCode !== 0) failure(mkdir, "SLURM_SUBMIT_FAILED", "Unable to create the controlled log directory.");
    const logDirectoryReal = await this.realpath(logDirectory);
    if (!logDirectoryReal || !isContained(workspaceReal, logDirectoryReal)) {
      throw new AgentError("PATH_NOT_ALLOWED", "Log directory resolves outside the remote workspace.", ExitCode.PolicyDenied);
    }
    const args = [
      "--parsable", `--chdir=${workspaceReal}`, `--partition=${options.partition}`, `--nodes=${options.nodes}`,
      `--ntasks=${options.ntasks}`, `--cpus-per-task=${options.cpusPerTask}`, `--mem=${options.memory}`,
      `--time=${options.time}`, `--output=${logDirectoryReal}/%j.out`, `--error=${logDirectoryReal}/%j.err`,
    ];
    if (options.jobName) args.push(`--job-name=${options.jobName}`);
    args.push("--", scriptReal);
    const result = await this.run({ executable: "sbatch", args });
    if (result.exitCode !== 0) failure(result, "SLURM_SUBMIT_FAILED", "Slurm rejected the submission.");
    return parseSubmittedJobId(result.stdout);
  }

  async cancel(jobId: string): Promise<void> {
    await this.getOwnedJob(jobId);
    const result = await this.run({ executable: "scancel", args: [jobId] });
    if (result.exitCode !== 0) failure(result, "SLURM_CANCEL_FAILED", `Unable to cancel job ${jobId}.`);
  }

  async logs(jobId: string, stream: "stdout" | "stderr", lines: number): Promise<LogResult> {
    await this.getOwnedJob(jobId);
    const workspaceReal = await this.workspaceRealpath();
    const requested = `${workspaceReal}/.slurm-agent/logs/${jobId}.${stream === "stdout" ? "out" : "err"}`;
    const logReal = await this.realpath(requested);
    if (!logReal) throw new AgentError("JOB_NOT_FOUND", `No ${stream} log exists for job ${jobId}.`, ExitCode.NotFound);
    if (!isContained(workspaceReal, logReal)) {
      throw new AgentError("PATH_NOT_ALLOWED", "Log resolves outside the remote workspace.", ExitCode.PolicyDenied);
    }
    const result = await this.run({ executable: "tail", args: [`--lines=${lines}`, "--", logReal], maxOutputBytes: this.policy.maxLogBytes });
    if (result.exitCode !== 0) failure(result, "SLURM_LOG_FAILED", `Unable to read ${stream} log for job ${jobId}.`);
    return { job_id: jobId, stream, content: result.stdout, truncated: result.stdoutTruncated ?? false };
  }
}
