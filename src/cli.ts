#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AuditLogger } from "./audit/logger.js";
import { runArtifact } from "./commands/artifact.js";
import { runArtifacts } from "./commands/artifacts.js";
import { runCancel } from "./commands/cancel.js";
import { runClusterInfo } from "./commands/cluster-info.js";
import { runFairshare } from "./commands/fairshare.js";
import { runHistory } from "./commands/history.js";
import { runHold } from "./commands/hold.js";
import { runList } from "./commands/list.js";
import { runLogs } from "./commands/logs.js";
import { runRelease } from "./commands/release.js";
import { runRequeue } from "./commands/requeue.js";
import { runSignal } from "./commands/signal.js";
import { runStatus } from "./commands/status.js";
import { runSubmit } from "./commands/submit.js";
import { runUsage } from "./commands/usage.js";
import { runUpdate } from "./commands/update.js";
import { runWait } from "./commands/wait.js";
import { loadConfig } from "./config/loader.js";
import { AgentError, ExitCode, invalid } from "./errors/errors.js";
import { loadPolicy } from "./policy/loader.js";
import { prepareLocalScript } from "./policy/script.js";
import {
  parsePositiveInteger, validateHistoryState, validateJobId, validateSignal, validateSubmit, validateUpdate,
  type SubmitOptions, type UpdateOptions,
} from "./policy/validator.js";
import { SlurmClient } from "./slurm/client.js";
import { SshExecutor } from "./transport/ssh.js";
import type { RemoteExecutor } from "./transport/types.js";

const VERSION = "0.6.0";
const HELP = `slurm-agent ${VERSION}

Usage:
  slurm-agent submit [options] SCRIPT [SCRIPT_ARGS...]
  slurm-agent cluster-info
  slurm-agent list
  slurm-agent history [--days N] [--state STATE] [--limit N]
  slurm-agent fairshare
  slurm-agent status JOB_ID
  slurm-agent usage JOB_ID
  slurm-agent cancel JOB_ID
  slurm-agent hold JOB_ID
  slurm-agent release JOB_ID
  slurm-agent requeue JOB_ID
  slurm-agent update JOB_ID [--time TIME] [--dependency SPEC] [--array-concurrency N]
  slurm-agent signal JOB_ID --signal NAME [--scope steps|batch|full]
  slurm-agent logs JOB_ID [--stream stdout|stderr] [--tail LINES]
  slurm-agent artifact JOB_ID --path RELATIVE_PATH
  slurm-agent artifacts JOB_ID
  slurm-agent wait JOB_ID [--timeout SECONDS] [--poll-interval SECONDS]

Submit options:
  -p, --partition NAME  required; policy allowlist
  -N, --nodes N         default: 1
  -n, --ntasks N        default: 1
  --ntasks-per-node N   policy-bounded MPI ranks per node
  -c, --cpus-per-task N default: 1
  --mem SIZE            default: 1G
  --mem-per-cpu SIZE    mutually exclusive with --mem
  --gpus N              policy-bounded total GPU count
  --gpus-per-node N     policy-bounded GPU count per node
  --gpus-per-task N     policy-bounded GPU count per task
  --gres ALIAS          policy-defined GRES request
  -A, --account ALIAS   policy-defined Slurm account
  -q, --qos ALIAS       policy-defined quality of service
  -C, --constraint ALIAS policy-defined node constraint
  --reservation ALIAS   policy-defined reservation
  --exclusive           request policy-approved exclusive nodes
  --array SPEC          array indexes/ranges with optional % concurrency
  --dependency SPEC     policy-approved Slurm job dependencies
  -t, --time HH:MM:SS   default: 01:00:00
  -J, --job-name NAME
  --apptainer-image ALIAS
  --venv ALIAS

Output is JSON by default. Configuration is read from SLURM_* environment variables.
Generic SSH or remote command execution is intentionally unavailable.`;

type Writer = Pick<NodeJS.WritableStream, "write">;
type ExecutorFactory = (config: ReturnType<typeof loadConfig>["ssh"]) => RemoteExecutor;

interface Parsed { command: string; positionals: string[]; options: Map<string, string> }

function parseArgs(argv: string[]): Parsed {
  if (argv.length === 0) throw invalid("A command is required. Use --help for usage.");
  const command = argv[0]!;
  const positionals: string[] = [];
  const options = new Map<string, string>();
  let positionalMode = false;
  const shortOptions: Record<string, string> = {
    "-p": "partition", "-N": "nodes", "-n": "ntasks", "-c": "cpus-per-task", "-t": "time", "-J": "job-name",
    "-A": "account", "-q": "qos", "-C": "constraint",
  };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (positionalMode) { positionals.push(token); continue; }
    if (token === "--") { positionalMode = true; continue; }
    if (token === "--exclusive") {
      if (options.has("exclusive")) throw invalid("Option --exclusive may only be specified once.");
      options.set("exclusive", "true");
      continue;
    }
    if (shortOptions[token]) {
      const value = argv[++index];
      if (value === undefined || value.startsWith("-")) throw invalid(`Option ${token} requires a value.`);
      const key = shortOptions[token]!;
      if (options.has(key)) throw invalid(`Option --${key} may only be specified once.`);
      options.set(key, value);
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      if (command === "submit") positionalMode = true;
      continue;
    }
    const equals = token.indexOf("=");
    const rawKey = equals >= 0 ? token.slice(2, equals) : token.slice(2);
    const key = rawKey === "memory" ? "mem" : rawKey;
    const value = equals >= 0 ? token.slice(equals + 1) : argv[++index];
    if (!key || value === undefined || (equals < 0 && value.startsWith("--"))) throw invalid(`Option --${key} requires a value.`);
    if (options.has(key)) throw invalid(`Option --${key} may only be specified once.`);
    options.set(key, value);
  }
  return { command, positionals, options };
}

const submitOptions = [
  "partition", "nodes", "ntasks", "ntasks-per-node", "cpus-per-task", "mem", "mem-per-cpu",
  "gpus", "gpus-per-node", "gpus-per-task", "gres", "exclusive", "array", "dependency",
  "account", "qos", "constraint", "reservation", "time", "job-name", "apptainer-image", "venv",
];

function enforceSubmitShape(parsed: Parsed): void {
  const unknown = [...parsed.options.keys()].filter((key) => !submitOptions.includes(key));
  if (unknown.length) throw invalid(`Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}.`);
  if (parsed.positionals.length < 1) throw invalid("Command submit requires a local SCRIPT path.");
  if (parsed.options.has("exclusive") && parsed.options.get("exclusive") !== "true") {
    throw invalid("--exclusive does not take a value.");
  }
}

function enforceShape(parsed: Parsed, allowedOptions: string[], positionalCount: number): void {
  const unknown = [...parsed.options.keys()].filter((key) => !allowedOptions.includes(key));
  if (unknown.length) throw invalid(`Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}.`);
  if (parsed.positionals.length !== positionalCount) throw invalid(`Command ${parsed.command} expects ${positionalCount} positional argument(s).`);
}

function prevalidateShape(parsed: Parsed): void {
  switch (parsed.command) {
    case "submit":
      enforceSubmitShape(parsed);
      break;
    case "list":
    case "cluster-info":
    case "fairshare":
      enforceShape(parsed, [], 0);
      break;
    case "history":
      enforceShape(parsed, ["days", "state", "limit"], 0);
      if (parsed.options.has("days")) parsePositiveInteger(parsed.options.get("days")!, "--days");
      if (parsed.options.has("limit")) parsePositiveInteger(parsed.options.get("limit")!, "--limit");
      if (parsed.options.has("state")) validateHistoryState(parsed.options.get("state")!);
      break;
    case "status":
    case "cancel":
    case "hold":
    case "release":
    case "requeue":
    case "usage":
    case "artifacts":
      enforceShape(parsed, [], 1);
      validateJobId(parsed.positionals[0]!);
      break;
    case "update":
      enforceShape(parsed, ["time", "dependency", "array-concurrency"], 1);
      validateJobId(parsed.positionals[0]!);
      if (!["time", "dependency", "array-concurrency"].some((option) => parsed.options.has(option))) {
        throw invalid("update requires at least one of --time, --dependency, or --array-concurrency.");
      }
      if (parsed.options.has("array-concurrency")) {
        parsePositiveInteger(parsed.options.get("array-concurrency")!, "--array-concurrency");
      }
      break;
    case "signal":
      enforceShape(parsed, ["signal", "scope"], 1);
      validateJobId(parsed.positionals[0]!);
      requiredOption(parsed.options, "signal");
      if (parsed.options.has("scope") && !["steps", "batch", "full"].includes(parsed.options.get("scope")!)) {
        throw invalid("--scope must be steps, batch, or full.");
      }
      break;
    case "logs": {
      enforceShape(parsed, ["stream", "tail"], 1);
      validateJobId(parsed.positionals[0]!);
      const stream = parsed.options.get("stream");
      if (stream !== undefined && stream !== "stdout" && stream !== "stderr") throw invalid("--stream must be stdout or stderr.");
      if (parsed.options.has("tail")) parsePositiveInteger(parsed.options.get("tail")!, "--tail");
      break;
    }
    case "artifact":
      enforceShape(parsed, ["path"], 1);
      validateJobId(parsed.positionals[0]!);
      requiredOption(parsed.options, "path");
      break;
    case "wait":
      enforceShape(parsed, ["timeout", "poll-interval"], 1);
      validateJobId(parsed.positionals[0]!);
      if (parsed.options.has("timeout")) parsePositiveInteger(parsed.options.get("timeout")!, "--timeout");
      if (parsed.options.has("poll-interval")) parsePositiveInteger(parsed.options.get("poll-interval")!, "--poll-interval");
      break;
  }
}

function requiredOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw invalid(`--${name} is required.`);
  return value;
}

function parseSubmit(parsed: Parsed, policy: ReturnType<typeof loadPolicy>): ReturnType<typeof validateSubmit> {
  enforceSubmitShape(parsed);
  const options: SubmitOptions = {
    script: parsed.positionals[0]!,
    partition: requiredOption(parsed.options, "partition"),
    nodes: parsePositiveInteger(parsed.options.get("nodes") ?? "1", "--nodes"),
    ntasks: parsePositiveInteger(parsed.options.get("ntasks") ?? "1", "--ntasks"),
    ntasksPerNode: parsed.options.has("ntasks-per-node")
      ? parsePositiveInteger(parsed.options.get("ntasks-per-node")!, "--ntasks-per-node") : undefined,
    cpusPerTask: parsePositiveInteger(parsed.options.get("cpus-per-task") ?? "1", "--cpus-per-task"),
    memory: parsed.options.has("mem") || !parsed.options.has("mem-per-cpu") ? parsed.options.get("mem") ?? "1G" : undefined,
    memoryPerCpu: parsed.options.get("mem-per-cpu"),
    gpus: parsed.options.has("gpus") ? parsePositiveInteger(parsed.options.get("gpus")!, "--gpus") : undefined,
    gpusPerNode: parsed.options.has("gpus-per-node")
      ? parsePositiveInteger(parsed.options.get("gpus-per-node")!, "--gpus-per-node") : undefined,
    gpusPerTask: parsed.options.has("gpus-per-task")
      ? parsePositiveInteger(parsed.options.get("gpus-per-task")!, "--gpus-per-task") : undefined,
    gres: parsed.options.get("gres"),
    exclusive: parsed.options.get("exclusive") === "true" || undefined,
    account: parsed.options.get("account"),
    qos: parsed.options.get("qos"),
    constraint: parsed.options.get("constraint"),
    reservation: parsed.options.get("reservation"),
    array: parsed.options.get("array"),
    dependency: parsed.options.get("dependency"),
    time: parsed.options.get("time") ?? "01:00:00",
    jobName: parsed.options.get("job-name"),
    apptainerImage: parsed.options.get("apptainer-image"),
    venv: parsed.options.get("venv"),
    scriptArgs: parsed.positionals.slice(1),
  };
  return validateSubmit(options, policy);
}

function parseUpdate(parsed: Parsed, policy: ReturnType<typeof loadPolicy>): ReturnType<typeof validateUpdate> {
  const options: UpdateOptions = {
    time: parsed.options.get("time"),
    dependency: parsed.options.get("dependency"),
    arrayConcurrency: parsed.options.has("array-concurrency")
      ? parsePositiveInteger(parsed.options.get("array-concurrency")!, "--array-concurrency") : undefined,
  };
  return validateUpdate(options, policy);
}

function writeJson(output: Writer, value: unknown): void { output.write(`${JSON.stringify(value)}\n`); }

export async function main(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  stdout: Writer = process.stdout,
  stderr: NodeJS.WritableStream = process.stderr,
  executorFactory: ExecutorFactory = (ssh) => new SshExecutor(ssh),
): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) { stdout.write(`${HELP}\n`); return 0; }
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) { stdout.write(`${VERSION}\n`); return 0; }

  let executor: RemoteExecutor | undefined;
  let audit: AuditLogger | undefined;
  let action = argv[0] ?? "unknown";
  let sshUser: string | undefined;
  let jobId: string | undefined;
  let auditResources: Record<string, unknown> | undefined;
  try {
    const parsed = parseArgs(argv);
    action = parsed.command;
    if (!["submit", "cluster-info", "list", "history", "fairshare", "status", "usage", "cancel", "hold", "release", "requeue", "update", "signal", "logs", "artifact", "artifacts", "wait"].includes(parsed.command)) {
      throw invalid(`Unknown command: ${parsed.command}.`);
    }
    prevalidateShape(parsed);
    const config = loadConfig(env);
    const policy = loadPolicy(config.policyPath);
    sshUser = config.ssh.user;
    audit = new AuditLogger(config.auditLogPath, stderr);
    executor = executorFactory(config.ssh);
    const client = new SlurmClient(
      executor, config.ssh.user, config.ssh.workspace, policy,
      config.localArtifactsPath, config.remoteApptainerPath,
    );
    const context = { client, audit, sshUser: config.ssh.user };
    let response: Record<string, unknown>;
    switch (parsed.command) {
      case "list":
        enforceShape(parsed, [], 0);
        response = await runList(context);
        break;
      case "cluster-info":
        enforceShape(parsed, [], 0);
        response = await runClusterInfo(context);
        break;
      case "fairshare":
        enforceShape(parsed, [], 0);
        response = await runFairshare(context);
        break;
      case "history": {
        const days = parsePositiveInteger(
          parsed.options.get("days") ?? String(Math.min(7, policy.maxHistoryDays)), "--days",
        );
        const limit = parsePositiveInteger(
          parsed.options.get("limit") ?? String(Math.min(50, policy.maxHistoryJobs)), "--limit",
        );
        const state = parsed.options.has("state") ? validateHistoryState(parsed.options.get("state")!) : undefined;
        if (days > policy.maxHistoryDays) {
          throw new AgentError("RESOURCE_LIMIT_EXCEEDED", `--days exceeds policy maximum ${policy.maxHistoryDays}.`, ExitCode.PolicyDenied);
        }
        if (limit > policy.maxHistoryJobs) {
          throw new AgentError("RESOURCE_LIMIT_EXCEEDED", `--limit exceeds policy maximum ${policy.maxHistoryJobs}.`, ExitCode.PolicyDenied);
        }
        auditResources = { days, state, limit };
        response = await runHistory(context, days, state, limit);
        break;
      }
      case "status":
        enforceShape(parsed, [], 1);
        jobId = validateJobId(parsed.positionals[0]!);
        response = await runStatus(context, jobId);
        break;
      case "usage":
        enforceShape(parsed, [], 1);
        jobId = validateJobId(parsed.positionals[0]!);
        response = await runUsage(context, jobId);
        break;
      case "cancel":
        enforceShape(parsed, [], 1);
        jobId = validateJobId(parsed.positionals[0]!);
        response = await runCancel(context, jobId);
        break;
      case "hold":
        enforceShape(parsed, [], 1);
        jobId = validateJobId(parsed.positionals[0]!);
        response = await runHold(context, jobId);
        break;
      case "release":
        enforceShape(parsed, [], 1);
        jobId = validateJobId(parsed.positionals[0]!);
        response = await runRelease(context, jobId);
        break;
      case "requeue":
        enforceShape(parsed, [], 1);
        jobId = validateJobId(parsed.positionals[0]!);
        response = await runRequeue(context, jobId);
        break;
      case "update": {
        jobId = validateJobId(parsed.positionals[0]!);
        const update = parseUpdate(parsed, policy);
        auditResources = {
          time: update.time, dependency: update.dependency, array_concurrency: update.arrayConcurrency,
        };
        response = await runUpdate(context, jobId, update);
        break;
      }
      case "signal": {
        jobId = validateJobId(parsed.positionals[0]!);
        const selected = validateSignal(
          requiredOption(parsed.options, "signal"), parsed.options.get("scope") ?? "steps", policy,
        );
        auditResources = selected;
        response = await runSignal(context, jobId, selected.signal, selected.scope);
        break;
      }
      case "logs": { 
        enforceShape(parsed, ["stream", "tail"], 1);
        jobId = validateJobId(parsed.positionals[0]!);
        const stream = parsed.options.get("stream") ?? "stdout";
        if (stream !== "stdout" && stream !== "stderr") throw invalid("--stream must be stdout or stderr.");
        const lines = parsePositiveInteger(parsed.options.get("tail") ?? "200", "--tail");
        auditResources = { stream, lines };
        if (lines > policy.maxLogLines) throw new AgentError("RESOURCE_LIMIT_EXCEEDED", `--tail exceeds policy maximum ${policy.maxLogLines}.`, ExitCode.PolicyDenied);
        response = await runLogs(context, jobId, stream, lines);
        break;
      }
      case "submit":
        auditResources = {
          partition: parsed.options.get("partition"), nodes: parsed.options.get("nodes") ?? "1",
          ntasks: parsed.options.get("ntasks") ?? "1", cpus_per_task: parsed.options.get("cpus-per-task") ?? "1",
          ntasks_per_node: parsed.options.get("ntasks-per-node"),
          memory: parsed.options.get("mem") ?? (parsed.options.has("mem-per-cpu") ? undefined : "1G"),
          memory_per_cpu: parsed.options.get("mem-per-cpu"), time: parsed.options.get("time") ?? "01:00:00",
          gpus: parsed.options.get("gpus"), gpus_per_node: parsed.options.get("gpus-per-node"),
          gpus_per_task: parsed.options.get("gpus-per-task"), gres: parsed.options.get("gres"),
          exclusive: parsed.options.has("exclusive") || undefined,
          account: parsed.options.get("account"), qos: parsed.options.get("qos"),
          constraint: parsed.options.get("constraint"), reservation: parsed.options.get("reservation"),
          array: parsed.options.get("array"), dependency: parsed.options.get("dependency"),
          apptainer_image: parsed.options.get("apptainer-image"), venv: parsed.options.get("venv"),
        };
        const submitOptions = parseSubmit(parsed, policy);
        const preparedScript = prepareLocalScript(config.localJobWorkspace, submitOptions.script, policy);
        response = await runSubmit(context, submitOptions, preparedScript);
        break;
      case "artifact": {
        jobId = validateJobId(parsed.positionals[0]!);
        const path = requiredOption(parsed.options, "path");
        auditResources = { path };
        response = await runArtifact(context, jobId, path);
        break;
      }
      case "artifacts":
        jobId = validateJobId(parsed.positionals[0]!);
        response = await runArtifacts(context, jobId);
        break;
      case "wait": {
        jobId = validateJobId(parsed.positionals[0]!);
        const timeoutSeconds = parsePositiveInteger(
          parsed.options.get("timeout") ?? String(Math.min(3600, policy.maxWaitSeconds)),
          "--timeout",
        );
        const pollIntervalSeconds = parsePositiveInteger(parsed.options.get("poll-interval") ?? "10", "--poll-interval");
        if (timeoutSeconds > policy.maxWaitSeconds) {
          throw new AgentError("RESOURCE_LIMIT_EXCEEDED", `--timeout exceeds policy maximum ${policy.maxWaitSeconds}.`, ExitCode.PolicyDenied);
        }
        if (pollIntervalSeconds > 300) {
          throw invalid("--poll-interval may not exceed 300 seconds.");
        }
        auditResources = { timeout_seconds: timeoutSeconds, poll_interval_seconds: pollIntervalSeconds };
        response = await runWait(context, jobId, timeoutSeconds, pollIntervalSeconds);
        break;
      }
      default:
        throw invalid("Unsupported command.");
    }
    writeJson(stdout, response);
    return ExitCode.Success;
  } catch (cause) {
    const error = cause instanceof AgentError
      ? cause
      : new AgentError("SLURM_QUERY_FAILED", "Unexpected internal failure.", ExitCode.General);
    try {
      audit?.write({
        action, ssh_user: sshUser, job_id: jobId, resources: auditResources,
        policy_decision: error.exitCode === ExitCode.PolicyDenied || error.exitCode === ExitCode.PermissionDenied ? "denied" : "allowed",
        result: "failure", error_code: error.code,
        remote_exit_code: typeof error.details?.remote_exit_code === "number" ? error.details.remote_exit_code : undefined,
      });
    } catch {
      // Preserve the original error and stdout contract if audit storage is unavailable.
    }
    const responseError: Record<string, unknown> = { code: error.code, message: error.message };
    if (typeof error.details?.slurm_message === "string") {
      responseError.slurm_message = error.details.slurm_message;
      if (error.details.slurm_message_truncated === true) responseError.slurm_message_truncated = true;
    }
    writeJson(stdout, { ok: false, error: responseError });
    return error.exitCode;
  } finally {
    await executor?.close().catch(() => undefined);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
