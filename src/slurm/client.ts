import { randomUUID } from "node:crypto";
import { AgentError, ExitCode } from "../errors/errors.js";
import { isContained, resolveLocalArtifactPath, resolveWorkspacePath } from "../policy/path.js";
import type { PreparedScript } from "../policy/script.js";
import type { NormalizedSubmit } from "../policy/validator.js";
import type { Policy } from "../policy/types.js";
import type { RemoteExecutor, RemoteResult, SafeCommand } from "../transport/types.js";
import { parseAccountingJob, parseQueueJob, parseQueueList, parseSubmittedJobId } from "./parser.js";
import type { ArtifactResult, JobSummary, LogResult, OwnedJob } from "./types.js";
import { TRUSTED_RUNNER } from "./runner.js";

function failure(result: RemoteResult, code: "SLURM_SUBMIT_FAILED" | "SLURM_QUERY_FAILED" | "SLURM_CANCEL_FAILED" | "SLURM_LOG_FAILED", message: string): never {
  throw new AgentError(code, message, ExitCode.SlurmFailure, { remote_exit_code: result.exitCode });
}

function validateExportPath(path: string, label: string): string {
  if (!/^\/[A-Za-z0-9_./+-]+$/.test(path) || path.split("/").includes("..")) {
    throw new AgentError("RUNTIME_NOT_FOUND", `${label} resolves to a path that cannot be safely exported.`, ExitCode.General);
  }
  return path;
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

  async submit(options: NormalizedSubmit, script: PreparedScript): Promise<string> {
    if (this.policy.requireApptainerForGeneratedScripts && !options.apptainerImagePath) {
      throw new AgentError("RUNTIME_REQUIRED", "Policy requires an approved Apptainer image for agent-generated scripts.", ExitCode.PolicyDenied);
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
    const args = [
      "--parsable", `--chdir=${workspaceReal}`, `--partition=${options.partition}`, `--nodes=${options.nodes}`,
      `--ntasks=${options.ntasks}`, `--cpus-per-task=${options.cpusPerTask}`, `--mem=${options.memory}`,
      `--time=${options.time}`, `--output=${logDirectoryReal}/%j.out`, `--error=${logDirectoryReal}/%j.err`,
      `--export=${exportedEnvironment.join(",")}`,
    ];
    if (options.jobName) args.push(`--job-name=${options.jobName}`);
    args.push("--", runnerPath, ...options.scriptArgs);
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
}
