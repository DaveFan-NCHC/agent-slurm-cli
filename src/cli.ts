#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AuditLogger } from "./audit/logger.js";
import { runCancel } from "./commands/cancel.js";
import { runList } from "./commands/list.js";
import { runLogs } from "./commands/logs.js";
import { runStatus } from "./commands/status.js";
import { runSubmit } from "./commands/submit.js";
import { loadConfig } from "./config/loader.js";
import { AgentError, ExitCode, invalid } from "./errors/errors.js";
import { loadPolicy } from "./policy/loader.js";
import { parsePositiveInteger, validateJobId, validateSubmit, type SubmitOptions } from "./policy/validator.js";
import { SlurmClient } from "./slurm/client.js";
import { SshExecutor } from "./transport/ssh.js";
import type { RemoteExecutor } from "./transport/types.js";

const VERSION = "0.1.0";
const HELP = `slurm-agent ${VERSION}

Usage:
  slurm-agent submit --script PATH --partition NAME [options]
  slurm-agent list
  slurm-agent status JOB_ID
  slurm-agent cancel JOB_ID
  slurm-agent logs JOB_ID [--stream stdout|stderr] [--tail LINES]

Submit options:
  --nodes N             default: 1
  --ntasks N            default: 1
  --cpus-per-task N     default: 1
  --memory SIZE         default: 1G
  --time HH:MM:SS       default: 01:00:00
  --job-name NAME

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
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) { positionals.push(token); continue; }
    const equals = token.indexOf("=");
    const key = equals >= 0 ? token.slice(2, equals) : token.slice(2);
    const value = equals >= 0 ? token.slice(equals + 1) : argv[++index];
    if (!key || value === undefined || (equals < 0 && value.startsWith("--"))) throw invalid(`Option --${key} requires a value.`);
    if (options.has(key)) throw invalid(`Option --${key} may only be specified once.`);
    options.set(key, value);
  }
  return { command, positionals, options };
}

function enforceShape(parsed: Parsed, allowedOptions: string[], positionalCount: number): void {
  const unknown = [...parsed.options.keys()].filter((key) => !allowedOptions.includes(key));
  if (unknown.length) throw invalid(`Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}.`);
  if (parsed.positionals.length !== positionalCount) throw invalid(`Command ${parsed.command} expects ${positionalCount} positional argument(s).`);
}

function prevalidateShape(parsed: Parsed): void {
  switch (parsed.command) {
    case "submit":
      enforceShape(parsed, ["script", "partition", "nodes", "ntasks", "cpus-per-task", "memory", "time", "job-name"], 0);
      break;
    case "list":
      enforceShape(parsed, [], 0);
      break;
    case "status":
    case "cancel":
      enforceShape(parsed, [], 1);
      validateJobId(parsed.positionals[0]!);
      break;
    case "logs": {
      enforceShape(parsed, ["stream", "tail"], 1);
      validateJobId(parsed.positionals[0]!);
      const stream = parsed.options.get("stream");
      if (stream !== undefined && stream !== "stdout" && stream !== "stderr") throw invalid("--stream must be stdout or stderr.");
      if (parsed.options.has("tail")) parsePositiveInteger(parsed.options.get("tail")!, "--tail");
      break;
    }
  }
}

function requiredOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw invalid(`--${name} is required.`);
  return value;
}

function parseSubmit(parsed: Parsed, policy: ReturnType<typeof loadPolicy>): ReturnType<typeof validateSubmit> {
  enforceShape(parsed, ["script", "partition", "nodes", "ntasks", "cpus-per-task", "memory", "time", "job-name"], 0);
  const options: SubmitOptions = {
    script: requiredOption(parsed.options, "script"),
    partition: requiredOption(parsed.options, "partition"),
    nodes: parsePositiveInteger(parsed.options.get("nodes") ?? "1", "--nodes"),
    ntasks: parsePositiveInteger(parsed.options.get("ntasks") ?? "1", "--ntasks"),
    cpusPerTask: parsePositiveInteger(parsed.options.get("cpus-per-task") ?? "1", "--cpus-per-task"),
    memory: parsed.options.get("memory") ?? "1G",
    time: parsed.options.get("time") ?? "01:00:00",
    jobName: parsed.options.get("job-name"),
  };
  return validateSubmit(options, policy);
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
    if (!["submit", "list", "status", "cancel", "logs"].includes(parsed.command)) {
      throw invalid(`Unknown command: ${parsed.command}.`);
    }
    prevalidateShape(parsed);
    const config = loadConfig(env);
    const policy = loadPolicy(config.policyPath);
    sshUser = config.ssh.user;
    audit = new AuditLogger(config.auditLogPath, stderr);
    executor = executorFactory(config.ssh);
    const client = new SlurmClient(executor, config.ssh.user, config.ssh.workspace, policy);
    const context = { client, audit, sshUser: config.ssh.user };
    let response: Record<string, unknown>;
    switch (parsed.command) {
      case "list":
        enforceShape(parsed, [], 0);
        response = await runList(context);
        break;
      case "status":
        enforceShape(parsed, [], 1);
        jobId = validateJobId(parsed.positionals[0]!);
        response = await runStatus(context, jobId);
        break;
      case "cancel":
        enforceShape(parsed, [], 1);
        jobId = validateJobId(parsed.positionals[0]!);
        response = await runCancel(context, jobId);
        break;
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
          memory: parsed.options.get("memory") ?? "1G", time: parsed.options.get("time") ?? "01:00:00",
        };
        response = await runSubmit(context, parseSubmit(parsed, policy));
        break;
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
    writeJson(stdout, { ok: false, error: { code: error.code, message: error.message } });
    return error.exitCode;
  } finally {
    await executor?.close().catch(() => undefined);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
