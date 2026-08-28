import { invalid, policyDenied } from "../errors/errors.js";
import type { Policy } from "./types.js";

export interface SubmitOptions {
  script: string;
  partition: string;
  nodes: number;
  ntasks: number;
  cpusPerTask: number;
  memory: string;
  time: string;
  jobName?: string;
  apptainerImage?: string;
  venv?: string;
  scriptArgs: string[];
}

export interface NormalizedSubmit extends SubmitOptions {
  memoryGb: number;
  timeMinutes: number;
  apptainerImagePath?: string;
  venvPath?: string;
}

const runtimeAliasPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function resolveRuntimeAlias(alias: string | undefined, allowed: Record<string, string>, label: string): string | undefined {
  if (alias === undefined) return undefined;
  if (!runtimeAliasPattern.test(alias)) throw invalid(`${label} must be a safe logical alias.`);
  const path = allowed[alias];
  if (!path) throw policyDenied("RUNTIME_ALIAS_NOT_ALLOWED", `${label} alias ${alias} is not permitted.`);
  return path;
}

export function parsePositiveInteger(text: string, option: string): number {
  if (!/^[1-9]\d*$/.test(text)) throw invalid(`${option} must be a positive integer.`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw invalid(`${option} is too large.`);
  return value;
}

export function parseMemoryGb(text: string): number {
  const match = /^(\d+)([KMGTP])$/i.exec(text);
  if (!match) throw invalid("--mem must use an integer followed by K, M, G, T, or P.");
  const amount = Number(match[1]);
  const unit = match[2]!.toUpperCase();
  if (!Number.isSafeInteger(amount) || amount <= 0) throw invalid("--mem must be positive.");
  const multipliers: Record<string, number> = { K: 1 / 1024 / 1024, M: 1 / 1024, G: 1, T: 1024, P: 1024 * 1024 };
  return amount * multipliers[unit]!;
}

export function parseTimeMinutes(text: string): number {
  let days = 0;
  let clock = text;
  if (text.includes("-")) {
    const parts = text.split("-");
    if (parts.length !== 2 || !/^\d+$/.test(parts[0]!)) throw invalid("--time must be DD-HH:MM:SS or HH:MM:SS.");
    days = Number(parts[0]);
    clock = parts[1]!;
  }
  const match = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(clock);
  if (!match) throw invalid("--time must be DD-HH:MM:SS or HH:MM:SS.");
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59 || (days > 0 && hours > 23)) throw invalid("--time contains an invalid clock value.");
  const total = days * 1440 + hours * 60 + minutes + (seconds > 0 ? 1 : 0);
  if (total <= 0) throw invalid("--time must be positive.");
  return total;
}

export function validateJobName(name: string | undefined): void {
  if (name !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name))) {
    throw invalid("--job-name must be 1-128 safe characters.");
  }
}

export function validateSubmit(options: SubmitOptions, policy: Policy): NormalizedSubmit {
  if (!/^[A-Za-z0-9_.-]+$/.test(options.partition)) throw invalid("Invalid partition name.");
  if (!policy.allowedPartitions.includes(options.partition)) {
    throw policyDenied("PARTITION_NOT_ALLOWED", `Partition ${options.partition} is not permitted.`);
  }
  validateJobName(options.jobName);
  if (options.apptainerImage && options.venv) {
    throw invalid("--apptainer-image and --venv are mutually exclusive.");
  }
  const apptainerImagePath = resolveRuntimeAlias(options.apptainerImage, policy.allowedApptainerImages, "Apptainer image");
  const venvPath = resolveRuntimeAlias(options.venv, policy.allowedVirtualenvs, "Virtual environment");
  if (policy.requireApptainerForGeneratedScripts && !apptainerImagePath) {
    throw policyDenied("RUNTIME_REQUIRED", "Policy requires an approved Apptainer image for agent-generated scripts.");
  }
  if (options.scriptArgs.length > policy.maxScriptArgs) {
    throw policyDenied("RESOURCE_LIMIT_EXCEEDED", `Script arguments exceed policy maximum ${policy.maxScriptArgs}.`);
  }
  for (const argument of options.scriptArgs) {
    if (argument.includes("\0") || argument.includes("\n") || argument.includes("\r")) {
      throw invalid("Script arguments may not contain control characters.");
    }
    if (Buffer.byteLength(argument, "utf8") > policy.maxScriptArgLength) {
      throw policyDenied("RESOURCE_LIMIT_EXCEEDED", `A script argument exceeds policy maximum ${policy.maxScriptArgLength} bytes.`);
    }
  }
  const limits: Array<[number, number, string]> = [
    [options.nodes, policy.maxNodes, "nodes"], [options.ntasks, policy.maxNtasks, "ntasks"],
    [options.cpusPerTask, policy.maxCpusPerTask, "cpus-per-task"],
  ];
  for (const [actual, max, label] of limits) {
    if (!Number.isInteger(actual) || actual < 1) throw invalid(`${label} must be a positive integer.`);
    if (actual > max) throw policyDenied("RESOURCE_LIMIT_EXCEEDED", `${label} exceeds policy maximum ${max}.`);
  }
  const memoryGb = parseMemoryGb(options.memory);
  if (memoryGb > policy.maxMemoryGb) {
    throw policyDenied("RESOURCE_LIMIT_EXCEEDED", `memory exceeds policy maximum ${policy.maxMemoryGb}G.`);
  }
  const timeMinutes = parseTimeMinutes(options.time);
  if (timeMinutes > policy.maxTimeMinutes) {
    throw policyDenied("TIME_LIMIT_EXCEEDED", `time exceeds policy maximum ${policy.maxTimeMinutes} minutes.`);
  }
  return { ...options, memoryGb, timeMinutes, apptainerImagePath, venvPath };
}

export function validateJobId(value: string): string {
  if (!/^[1-9]\d*$/.test(value)) throw invalid("Job ID must contain decimal digits only.", "INVALID_JOB_ID");
  return value;
}
