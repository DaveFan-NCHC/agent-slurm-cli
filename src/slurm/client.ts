import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { AgentError, ExitCode } from "../errors/errors.js";
import { isContained, resolveLocalArtifactPath, resolveWorkspacePath } from "../policy/path.js";
import type { PreparedScript } from "../policy/script.js";
import type { NormalizedSubmit, NormalizedUpdate, SignalScope } from "../policy/validator.js";
import type { Policy } from "../policy/types.js";
import type { RemoteExecutor, RemoteResult, SafeCommand } from "../transport/types.js";
import {
  parseAccountingJobs, parseArtifactList, parseClusterInfo, parseFairShare, parseHistory, parseJobUsage, parseLiveUsage,
  parseQueueJobs, parseQueueList, parseSubmittedJobId,
} from "./parser.js";
import type {
  ArtifactEntry, ArtifactResult, FairShareEntry, HistoryJob, JobSummary, JobUsage, LogResult, OwnedJob,
  PartitionInfo, WaitResult,
} from "./types.js";
import { TRUSTED_RUNNER } from "./runner.js";

const QUEUE_LIST_FORMAT = "%i|%j|%P|%T|%M|%r|%Q|%S|%V|%l|%L|%N|%D|%C|%a|%q|%v";
const QUEUE_JOB_FORMAT = "%i|%u|%j|%P|%T|%M|%r|%Q|%S|%V|%l|%L|%N|%D|%C|%a|%q|%v";
const ACCOUNTING_JOB_FORMAT = "JobIDRaw,User,JobName,Partition,State,Elapsed,ExitCode,Reason,Priority,Start,Submit,Timelimit,NodeList,AllocNodes,AllocCPUS,Account,QOS,Reservation";
const MAX_EXPOSED_SLURM_MESSAGE_BYTES = 4096;

function exposedSlurmMessage(result: RemoteResult): Record<string, unknown> {
  const sanitized = stripVTControlCharacters(result.stderr)
    .replace(/\r\n?/g, "\n")
    .replace(/\p{C}/gu, (character) => character === "\n" || character === "\t" ? character : "")
    .trim();
  if (!sanitized) return {};
  let message = "";
  let bytes = 0;
  for (const character of sanitized) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > MAX_EXPOSED_SLURM_MESSAGE_BYTES) break;
    message += character;
    bytes += characterBytes;
  }
  const truncated = result.stderrTruncated === true || bytes < Buffer.byteLength(sanitized);
  return {
    slurm_message: message,
    ...(truncated ? { slurm_message_truncated: true } : {}),
  };
}

function failure(
  result: RemoteResult,
  code: "SLURM_SUBMIT_FAILED" | "SLURM_QUERY_FAILED" | "SLURM_CANCEL_FAILED" | "SLURM_CONTROL_FAILED" | "SLURM_LOG_FAILED",
  message: string,
): never {
  throw new AgentError(code, message, ExitCode.SlurmFailure, {
    remote_exit_code: result.exitCode,
    ...exposedSlurmMessage(result),
  });
}

function validateExportPath(path: string, label: string): string {
  if (!/^\/[A-Za-z0-9_./+-]+$/.test(path) || path.split("/").includes("..")) {
    throw new AgentError("RUNTIME_NOT_FOUND", `${label} resolves to a path that cannot be safely exported.`, ExitCode.General);
  }
  return path;
}

function matchesJobReference(reference: string, candidate: string): boolean {
  return candidate === reference || (!reference.includes("_") && candidate.startsWith(`${reference}_`));
}

export class SlurmClient {
  constructor(
    private readonly executor: RemoteExecutor,
    private readonly user: string,
    private readonly workspace: string,
    private readonly policy: Policy,
    private readonly localArtifactsPath?: string,
    private readonly remoteApptainerPath = "/usr/bin/apptainer",
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

  private async runtimePath(configuredPath: string, kind: "apptainer" | "venv"): Promise<string> {
    const label = kind === "apptainer" ? "Apptainer image" : "Virtual environment";
    const resolved = await this.realpath(configuredPath);
    if (!resolved) throw new AgentError("RUNTIME_NOT_FOUND", `${label} configured by policy does not exist.`, ExitCode.General);
    validateExportPath(resolved, label);
    const expectedType = await this.run({ executable: "test", args: [kind === "apptainer" ? "-f" : "-d", resolved] });
    if (expectedType.exitCode !== 0) {
      throw new AgentError("RUNTIME_NOT_FOUND", `${label} configured by policy has the wrong file type.`, ExitCode.General);
    }
    if (kind === "venv") {
      const python = await this.run({ executable: "test", args: ["-x", `${resolved}/bin/python`] });
      if (python.exitCode !== 0) {
        throw new AgentError("RUNTIME_NOT_FOUND", "Virtual environment does not contain an executable bin/python.", ExitCode.General);
      }
    }
    return resolved;
  }

  async list(): Promise<JobSummary[]> {
    const result = await this.run({
      executable: "squeue", args: ["--noheader", "--array", "--user", this.user, `--format=${QUEUE_LIST_FORMAT}`],
    });
    if (result.exitCode !== 0) failure(result, "SLURM_QUERY_FAILED", "Unable to list Slurm jobs.");
    return parseQueueList(result.stdout);
  }

  async clusterInfo(): Promise<PartitionInfo[]> {
    const result = await this.run({
      executable: "sinfo",
      args: [
        "--noheader",
        `--partition=${this.policy.allowedPartitions.join(",")}`,
        "--format=%P|%a|%l|%D|%t|%C|%G",
      ],
    });
    if (result.exitCode !== 0) failure(result, "SLURM_QUERY_FAILED", "Unable to query Slurm cluster information.");
    const partitions = parseClusterInfo(result.stdout);
    if (partitions.some((partition) => !this.policy.allowedPartitions.includes(partition.partition))) {
      throw new AgentError("SLURM_QUERY_FAILED", "Slurm returned a partition outside the configured policy.", ExitCode.SlurmFailure);
    }
    return partitions;
  }

  async history(days: number, state: string | undefined, limit: number): Promise<HistoryJob[]> {
    const args = [
      "--noheader", "--parsable2", "--allocations", "--local", `--user=${this.user}`,
      `--starttime=now-${days}days`,
      "--format=JobIDRaw,User,JobName,Partition,State,Elapsed,Start,End,ExitCode,AllocCPUS,AllocNodes,ReqMem,ReqTRES",
    ];
    if (state) args.push(`--state=${state}`);
    const result = await this.run({ executable: "sacct", args, maxOutputBytes: 1048576 });
    if (result.exitCode !== 0) failure(result, "SLURM_QUERY_FAILED", "Unable to query Slurm job history.");
    if (result.stdoutTruncated) {
      throw new AgentError("SLURM_QUERY_FAILED", "Slurm job history exceeded the safe output limit.", ExitCode.SlurmFailure);
    }
    const jobs = parseHistory(result.stdout);
    if (jobs.some((job) => job.user !== this.user)) {
      throw new AgentError("SLURM_QUERY_FAILED", "Slurm returned history for another user.", ExitCode.SlurmFailure);
    }
    return jobs.reverse().slice(0, limit).map(({ user: _user, ...job }) => job);
  }

  async getOwnedJob(jobId: string): Promise<OwnedJob> {
    const active = await this.run({
      executable: "squeue", args: ["--noheader", "--array", "--jobs", jobId, `--format=${QUEUE_JOB_FORMAT}`],
    });
    if (active.exitCode === 0) {
      const activeJobs = parseQueueJobs(active.stdout);
      const job = activeJobs.find((candidate) => candidate.job_id === jobId);
      if (job) return this.assertOwner(job);
      if (!jobId.includes("_") && activeJobs.some((candidate) => matchesJobReference(jobId, candidate.job_id))) {
        throw new AgentError(
          "INVALID_ARGUMENT",
          `Job ${jobId} is an array parent; use an explicit array task ID such as ${jobId}_0 for this operation.`,
          ExitCode.InvalidArguments,
        );
      }
    }
    const accounting = await this.run({
      executable: "sacct",
      args: ["--noheader", "--parsable2", "--allocations", "--jobs", jobId, `--format=${ACCOUNTING_JOB_FORMAT}`],
    });
    if (accounting.exitCode !== 0) failure(accounting, "SLURM_QUERY_FAILED", "Unable to query Slurm accounting.");
    const accountingJobs = parseAccountingJobs(accounting.stdout);
    const job = accountingJobs.find((candidate) => candidate.job_id === jobId);
    if (!job) {
      if (!jobId.includes("_") && accountingJobs.some((candidate) => matchesJobReference(jobId, candidate.job_id))) {
        throw new AgentError(
          "INVALID_ARGUMENT",
          `Job ${jobId} is an array parent; use an explicit array task ID such as ${jobId}_0 for this operation.`,
          ExitCode.InvalidArguments,
        );
      }
      throw new AgentError("JOB_NOT_FOUND", `Job ${jobId} was not found.`, ExitCode.NotFound);
    }
    return this.assertOwner(job);
  }

  private async assertOwnedJobReference(jobId: string): Promise<void> {
    const active = await this.run({
      executable: "squeue",
      args: ["--noheader", "--array", "--jobs", jobId, "--format=%i|%u|%j|%P|%T|%M"],
      maxOutputBytes: 1048576,
    });
    if (active.exitCode === 0) {
      if (active.stdoutTruncated) {
        throw new AgentError("SLURM_QUERY_FAILED", "Slurm job ownership output exceeded the safe limit.", ExitCode.SlurmFailure);
      }
      const matches = parseQueueJobs(active.stdout).filter((job) => matchesJobReference(jobId, job.job_id));
      if (matches.length > 0) {
        for (const job of matches) this.assertOwner(job);
        return;
      }
    }
    const accounting = await this.run({
      executable: "sacct",
      args: ["--noheader", "--parsable2", "--allocations", "--jobs", jobId, "--format=JobIDRaw,User,JobName,Partition,State,Elapsed,ExitCode"],
      maxOutputBytes: 1048576,
    });
    if (accounting.exitCode !== 0) failure(accounting, "SLURM_QUERY_FAILED", "Unable to query Slurm accounting.");
    if (accounting.stdoutTruncated) {
      throw new AgentError("SLURM_QUERY_FAILED", "Slurm job ownership output exceeded the safe limit.", ExitCode.SlurmFailure);
    }
    const matches = parseAccountingJobs(accounting.stdout).filter((job) => matchesJobReference(jobId, job.job_id));
    if (matches.length === 0) throw new AgentError("JOB_NOT_FOUND", `Job ${jobId} was not found.`, ExitCode.NotFound);
    for (const job of matches) this.assertOwner(job);
  }

  async usage(jobId: string): Promise<JobUsage> {
    await this.getOwnedJob(jobId);
    const accounting = await this.run({
      executable: "sacct",
      args: [
        "--noheader", "--parsable2", "--local", `--jobs=${jobId}`,
        "--format=JobIDRaw,User,JobName,Partition,State,Elapsed,ElapsedRaw,AllocCPUS,AllocNodes,ReqMem,ReqTRES,AllocTRES,TotalCPU,MaxRSS,MaxVMSize,MaxDiskRead,MaxDiskWrite,ExitCode",
      ],
      maxOutputBytes: 1048576,
    });
    if (accounting.exitCode !== 0) failure(accounting, "SLURM_QUERY_FAILED", "Unable to query Slurm resource usage.");
    if (accounting.stdoutTruncated) {
      throw new AgentError("SLURM_QUERY_FAILED", "Slurm resource usage exceeded the safe output limit.", ExitCode.SlurmFailure);
    }
    const parsed = parseJobUsage(accounting.stdout, jobId);
    if (!parsed) throw new AgentError("JOB_NOT_FOUND", `No accounting usage exists for job ${jobId}.`, ExitCode.NotFound);
    if (parsed.user !== this.user) {
      throw new AgentError("JOB_NOT_OWNED_BY_USER", `Job ${jobId} does not belong to the configured SSH user.`, ExitCode.PermissionDenied);
    }
    const usage = parsed.usage;
    if (!isTerminalState(usage.state) && usage.state.toUpperCase() !== "PENDING") {
      const live = await this.run({
        executable: "sstat",
        args: [
          "--noheader", "--parsable2", "--allsteps", `--jobs=${jobId}`,
          "--format=JobID,AveCPU,MaxRSS,MaxVMSize,MaxDiskRead,MaxDiskWrite,AllocTRES",
        ],
        maxOutputBytes: 1048576,
      });
      if (live.exitCode === 0 && !live.stdoutTruncated) {
        const liveSteps = parseLiveUsage(live.stdout);
        if (liveSteps.length > 0) {
          usage.live_steps = liveSteps;
          usage.live_available = true;
        }
      }
    }
    return usage;
  }

  private assertOwner(job: OwnedJob): OwnedJob {
    if (job.user !== this.user) {
      throw new AgentError("JOB_NOT_OWNED_BY_USER", `Job ${job.job_id} does not belong to the configured SSH user.`, ExitCode.PermissionDenied);
    }
    return job;
  }

  async submit(options: NormalizedSubmit, script: PreparedScript): Promise<string> {
    if (this.policy.requireApptainerForGeneratedScripts && !options.apptainerImagePath) {
      throw new AgentError("RUNTIME_REQUIRED", "Policy requires an approved Apptainer image for agent-generated scripts.", ExitCode.PolicyDenied);
    }
    for (const dependencyJobId of options.dependencyJobIds ?? []) {
      await this.assertOwnedJobReference(dependencyJobId);
    }
    const workspaceReal = await this.workspaceRealpath();
    const apptainerImageReal = options.apptainerImagePath
      ? await this.runtimePath(options.apptainerImagePath, "apptainer")
      : undefined;
    const venvReal = options.venvPath ? await this.runtimePath(options.venvPath, "venv") : undefined;
    const apptainerExecutableReal = apptainerImageReal
      ? await this.realpath(this.remoteApptainerPath)
      : undefined;
    if (apptainerImageReal && !apptainerExecutableReal) {
      throw new AgentError("RUNTIME_NOT_FOUND", "Configured Apptainer executable does not exist.", ExitCode.General);
    }
    if (apptainerExecutableReal) {
      validateExportPath(apptainerExecutableReal, "Apptainer executable");
      const executable = await this.run({ executable: "test", args: ["-x", apptainerExecutableReal] });
      if (executable.exitCode !== 0) {
        throw new AgentError("RUNTIME_NOT_FOUND", "Configured Apptainer executable is not executable.", ExitCode.General);
      }
    }
    const logDirectory = `${workspaceReal}/.slurm-agent/logs`;
    const artifactRoot = `${workspaceReal}/.slurm-agent/artifacts`;
    const submissionDirectory = `${workspaceReal}/.slurm-agent/submissions/${randomUUID()}`;
    const mkdir = await this.run({ executable: "mkdir", args: ["-p", "-m", "700", "--", logDirectory, artifactRoot, submissionDirectory] });
    if (mkdir.exitCode !== 0) failure(mkdir, "SLURM_SUBMIT_FAILED", "Unable to create controlled output directories.");
    const logDirectoryReal = await this.realpath(logDirectory);
    if (!logDirectoryReal || !isContained(workspaceReal, logDirectoryReal)) {
      throw new AgentError("PATH_NOT_ALLOWED", "Log directory resolves outside the remote workspace.", ExitCode.PolicyDenied);
    }
    const artifactRootReal = await this.realpath(artifactRoot);
    if (!artifactRootReal || !isContained(workspaceReal, artifactRootReal)) {
      throw new AgentError("PATH_NOT_ALLOWED", "Artifact directory resolves outside the remote workspace.", ExitCode.PolicyDenied);
    }
    const submissionDirectoryReal = await this.realpath(submissionDirectory);
    if (!submissionDirectoryReal || !isContained(workspaceReal, submissionDirectoryReal)) {
      throw new AgentError("PATH_NOT_ALLOWED", "Submission directory resolves outside the remote workspace.", ExitCode.PolicyDenied);
    }
    const payloadPath = `${submissionDirectoryReal}/payload`;
    const runnerPath = `${submissionDirectoryReal}/runner`;
    await this.executor.uploadSubmission({ content: script.content, remotePath: payloadPath, maxBytes: this.policy.maxScriptBytes });
    const runner = Buffer.from(TRUSTED_RUNNER, "utf8");
    await this.executor.uploadSubmission({ content: runner, remotePath: runnerPath, maxBytes: runner.length });
    const exportedEnvironment = [`SLURM_AGENT_ARTIFACT_ROOT=${artifactRootReal}`];
    exportedEnvironment.push(`SLURM_AGENT_PAYLOAD=${payloadPath}`);
    const runtimeKind = apptainerImageReal ? "apptainer" : venvReal ? "venv" : "host";
    exportedEnvironment.push(`SLURM_AGENT_RUNTIME_KIND=${runtimeKind}`);
    if (apptainerImageReal) exportedEnvironment.push(`SLURM_AGENT_APPTAINER_IMAGE=${apptainerImageReal}`);
    if (venvReal) exportedEnvironment.push(`SLURM_AGENT_VENV=${venvReal}`);
    if (apptainerExecutableReal) exportedEnvironment.push(`SLURM_AGENT_APPTAINER_EXECUTABLE=${apptainerExecutableReal}`);
    if (apptainerImageReal) {
      exportedEnvironment.push(`SLURM_AGENT_SUBMISSION_DIR=${submissionDirectoryReal}`);
      exportedEnvironment.push(`SLURM_AGENT_WORKSPACE=${workspaceReal}`);
    }
    const logIdPattern = options.array ? "%A_%a" : "%j";
    const args = [
      "--parsable", `--chdir=${workspaceReal}`, `--partition=${options.partition}`, `--nodes=${options.nodes}`,
      `--ntasks=${options.ntasks}`, `--cpus-per-task=${options.cpusPerTask}`,
      `--time=${options.time}`, `--output=${logDirectoryReal}/${logIdPattern}.out`, `--error=${logDirectoryReal}/${logIdPattern}.err`,
      `--export=${exportedEnvironment.join(",")}`,
    ];
    if (options.jobName) args.push(`--job-name=${options.jobName}`);
    if (options.ntasksPerNode !== undefined) args.push(`--ntasks-per-node=${options.ntasksPerNode}`);
    if (options.memory !== undefined) args.push(`--mem=${options.memory}`);
    if (options.memoryPerCpu !== undefined) args.push(`--mem-per-cpu=${options.memoryPerCpu}`);
    if (options.gpus !== undefined) args.push(`--gpus=${options.gpus}`);
    if (options.gpusPerNode !== undefined) args.push(`--gpus-per-node=${options.gpusPerNode}`);
    if (options.gpusPerTask !== undefined) args.push(`--gpus-per-task=${options.gpusPerTask}`);
    if (options.gresValue !== undefined) args.push(`--gres=${options.gresValue}`);
    if (options.accountValue !== undefined) args.push(`--account=${options.accountValue}`);
    if (options.qosValue !== undefined) args.push(`--qos=${options.qosValue}`);
    if (options.constraintValue !== undefined) args.push(`--constraint=${options.constraintValue}`);
    if (options.nodelistValue !== undefined) args.push(`--nodelist=${options.nodelistValue}`);
    if (options.excludeValue !== undefined) args.push(`--exclude=${options.excludeValue}`);
    if (options.reservationValue !== undefined) args.push(`--reservation=${options.reservationValue}`);
    if (options.exclusive) args.push("--exclusive");
    if (options.array !== undefined) args.push(`--array=${options.array}`);
    if (options.dependency !== undefined) args.push(`--dependency=${options.dependency}`);
    args.push("--", runnerPath, ...options.scriptArgs);
    const result = await this.run({ executable: "sbatch", args });
    if (result.exitCode !== 0) failure(result, "SLURM_SUBMIT_FAILED", "Slurm rejected the submission.");
    return parseSubmittedJobId(result.stdout);
  }

  async cancel(jobId: string): Promise<void> {
    await this.assertOwnedJobReference(jobId);
    const result = await this.run({ executable: "scancel", args: [jobId] });
    if (result.exitCode !== 0) failure(result, "SLURM_CANCEL_FAILED", `Unable to cancel job ${jobId}.`);
  }

  async hold(jobId: string): Promise<void> {
    await this.assertOwnedJobReference(jobId);
    const result = await this.run({ executable: "scontrol", args: ["hold", jobId] });
    if (result.exitCode !== 0) failure(result, "SLURM_CONTROL_FAILED", `Unable to hold job ${jobId}.`);
  }

  async release(jobId: string): Promise<void> {
    await this.assertOwnedJobReference(jobId);
    const result = await this.run({ executable: "scontrol", args: ["release", jobId] });
    if (result.exitCode !== 0) failure(result, "SLURM_CONTROL_FAILED", `Unable to release job ${jobId}.`);
  }

  async requeue(jobId: string): Promise<void> {
    await this.assertOwnedJobReference(jobId);
    const result = await this.run({ executable: "scontrol", args: ["requeue", jobId] });
    if (result.exitCode !== 0) failure(result, "SLURM_CONTROL_FAILED", `Unable to requeue job ${jobId}.`);
  }

  async update(jobId: string, options: NormalizedUpdate): Promise<void> {
    await this.assertOwnedJobReference(jobId);
    for (const dependencyJobId of options.dependencyJobIds ?? []) {
      await this.assertOwnedJobReference(dependencyJobId);
    }
    const args = ["update", `JobId=${jobId}`];
    if (options.time !== undefined) args.push(`TimeLimit=${options.time}`);
    if (options.dependency !== undefined) args.push(`Dependency=${options.dependency}`);
    if (options.arrayConcurrency !== undefined) args.push(`ArrayTaskThrottle=${options.arrayConcurrency}`);
    const result = await this.run({ executable: "scontrol", args });
    if (result.exitCode !== 0) failure(result, "SLURM_CONTROL_FAILED", `Unable to update job ${jobId}.`);
  }

  async signal(jobId: string, signal: string, scope: SignalScope): Promise<void> {
    await this.assertOwnedJobReference(jobId);
    const args = [`--signal=${signal}`];
    if (scope === "batch") args.push("--batch");
    if (scope === "full") args.push("--full");
    args.push(jobId);
    const result = await this.run({ executable: "scancel", args });
    if (result.exitCode !== 0) failure(result, "SLURM_CONTROL_FAILED", `Unable to signal job ${jobId}.`);
  }

  async fairshare(): Promise<FairShareEntry[]> {
    const result = await this.run({
      executable: "sshare",
      args: [
        "--noheader", "--parsable2", "--long", "--Users", `--users=${this.user}`,
        "--format=Account,User,RawShares,NormShares,RawUsage,EffectvUsage,FairShare,LevelFS,GrpTRESMins,TRESRunMins",
      ],
      maxOutputBytes: 1048576,
    });
    if (result.exitCode !== 0) failure(result, "SLURM_QUERY_FAILED", "Unable to query Slurm fair-share information.");
    if (result.stdoutTruncated) {
      throw new AgentError("SLURM_QUERY_FAILED", "Slurm fair-share output exceeded the safe limit.", ExitCode.SlurmFailure);
    }
    const entries = parseFairShare(result.stdout);
    if (entries.some((entry) => entry.user !== this.user)) {
      throw new AgentError("SLURM_QUERY_FAILED", "Slurm returned fair-share information for another user.", ExitCode.SlurmFailure);
    }
    return entries;
  }

  async wait(jobId: string, timeoutSeconds: number, pollIntervalSeconds: number): Promise<WaitResult> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let job = await this.getOwnedJob(jobId);
    while (!isTerminalState(job.state)) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return { job, terminal: false, timed_out: true };
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollIntervalSeconds * 1000, remainingMs)));
      try {
        job = await this.getOwnedJob(jobId);
      } catch (cause) {
        // Slurm accounting can briefly lag after a job leaves squeue.
        if (!(cause instanceof AgentError) || cause.code !== "JOB_NOT_FOUND") throw cause;
      }
    }
    return { job, terminal: true, timed_out: false };
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

  async artifact(jobId: string, artifactPath: string): Promise<ArtifactResult> {
    if (!this.localArtifactsPath) {
      throw new AgentError("CONFIGURATION_ERROR", "SLURM_LOCAL_ARTIFACTS is required for artifact downloads.", ExitCode.General);
    }
    const safeRelative = resolveWorkspacePath("/artifact", artifactPath).slice("/artifact/".length);
    await this.getOwnedJob(jobId);
    const workspaceReal = await this.workspaceRealpath();
    const artifactDirectory = `${workspaceReal}/.slurm-agent/artifacts/${jobId}`;
    const artifactDirectoryReal = await this.realpath(artifactDirectory);
    if (!artifactDirectoryReal) {
      throw new AgentError("ARTIFACT_NOT_FOUND", `No artifact directory exists for job ${jobId}.`, ExitCode.NotFound);
    }
    if (!isContained(workspaceReal, artifactDirectoryReal)) {
      throw new AgentError("PATH_NOT_ALLOWED", "Artifact directory resolves outside the remote workspace.", ExitCode.PolicyDenied);
    }
    const remotePath = await this.realpath(`${artifactDirectoryReal}/${safeRelative}`);
    if (!remotePath) throw new AgentError("ARTIFACT_NOT_FOUND", "Artifact was not found.", ExitCode.NotFound);
    if (!isContained(artifactDirectoryReal, remotePath)) {
      throw new AgentError("PATH_NOT_ALLOWED", "Artifact resolves outside its job directory.", ExitCode.PolicyDenied);
    }
    const localPath = resolveLocalArtifactPath(this.localArtifactsPath, jobId, safeRelative);
    const downloaded = await this.executor.downloadArtifact({ remotePath, localPath, maxBytes: this.policy.maxArtifactBytes });
    return { job_id: jobId, remote_path: remotePath, local_path: localPath, bytes: downloaded.bytes };
  }

  async artifacts(jobId: string): Promise<ArtifactEntry[]> {
    await this.getOwnedJob(jobId);
    const workspaceReal = await this.workspaceRealpath();
    const artifactDirectory = `${workspaceReal}/.slurm-agent/artifacts/${jobId}`;
    const artifactDirectoryReal = await this.realpath(artifactDirectory);
    if (!artifactDirectoryReal) {
      throw new AgentError("ARTIFACT_NOT_FOUND", `No artifact directory exists for job ${jobId}.`, ExitCode.NotFound);
    }
    if (!isContained(workspaceReal, artifactDirectoryReal)) {
      throw new AgentError("PATH_NOT_ALLOWED", "Artifact directory resolves outside the remote workspace.", ExitCode.PolicyDenied);
    }
    const result = await this.run({
      executable: "find",
      args: ["--", artifactDirectoryReal, "-xdev", "-type", "f", "-printf", "%P\\0%s\\0"],
      maxOutputBytes: 1048576,
    });
    if (result.exitCode !== 0) failure(result, "SLURM_QUERY_FAILED", `Unable to list artifacts for job ${jobId}.`);
    if (result.stdoutTruncated) {
      throw new AgentError("ARTIFACT_LIST_TOO_LARGE", "Artifact listing exceeded the safe output limit.", ExitCode.PolicyDenied);
    }
    return parseArtifactList(result.stdout, this.policy.maxArtifactFiles);
  }
}

const TERMINAL_STATES = new Set([
  "BOOT_FAIL", "CANCELLED", "COMPLETED", "DEADLINE", "FAILED", "NODE_FAIL",
  "OUT_OF_MEMORY", "PREEMPTED", "REVOKED", "TIMEOUT",
]);

function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state.toUpperCase().split(/[ +]/, 1)[0]!);
}
