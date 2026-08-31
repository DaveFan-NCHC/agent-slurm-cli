import { invalid, policyDenied } from "../errors/errors.js";
import type { Policy } from "./types.js";

export interface SubmitOptions {
  script: string;
  partition: string;
  nodes: number;
  ntasks: number;
  cpusPerTask: number;
  memory: string;
  gpus?: number;
  gres?: string;
  array?: string;
  dependency?: string;
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
  gresValue?: string;
  arrayTaskCount?: number;
  arrayConcurrency?: number;
  dependencyJobIds?: string[];
}

const runtimeAliasPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const historyStates = new Set([
  "BOOT_FAIL", "CANCELLED", "COMPLETED", "DEADLINE", "FAILED", "NODE_FAIL",
  "OUT_OF_MEMORY", "PENDING", "PREEMPTED", "RUNNING", "REQUEUED", "RESIZING",
  "REVOKED", "SUSPENDED", "TIMEOUT",
]);

function resolveRuntimeAlias(alias: string | undefined, allowed: Record<string, string>, label: string): string | undefined {
  if (alias === undefined) return undefined;
  if (!runtimeAliasPattern.test(alias)) throw invalid(`${label} must be a safe logical alias.`);
  const path = allowed[alias];
  if (!path) throw policyDenied("RUNTIME_ALIAS_NOT_ALLOWED", `${label} alias ${alias} is not permitted.`);
  return path;
}

function resolveGresAlias(alias: string | undefined, allowed: Record<string, string>): string | undefined {
  if (alias === undefined) return undefined;
  if (!runtimeAliasPattern.test(alias)) throw invalid("GRES must be a safe logical alias.");
  const value = allowed[alias];
  if (!value) throw policyDenied("GRES_ALIAS_NOT_ALLOWED", `GRES alias ${alias} is not permitted.`);
  return value;
}

export function parsePositiveInteger(text: string, option: string): number {
  if (!/^[1-9]\d*$/.test(text)) throw invalid(`${option} must be a positive integer.`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw invalid(`${option} is too large.`);
  return value;
}

export function validateHistoryState(value: string): string {
  const normalized = value.toUpperCase();
  if (!historyStates.has(normalized)) throw invalid("--state is not a supported Slurm job state.");
  return normalized;
}

function parseNonNegativeSafeInteger(text: string, label: string): number {
  if (!/^\d+$/.test(text)) throw invalid(`${label} must be a non-negative integer.`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw invalid(`${label} is too large.`);
  return value;
}

export function validateArray(value: string | undefined, policy: Policy): {
  value?: string; taskCount?: number; concurrency?: number;
} {
  if (value === undefined) return {};
  const throttleParts = value.split("%");
  if (throttleParts.length > 2 || !throttleParts[0] || (throttleParts.length === 2 && !throttleParts[1])) {
    throw invalid("--array must use INDEX[,INDEX|RANGE[:STEP]...][%CONCURRENCY].");
  }
  const entries = throttleParts[0]!.split(",");
  if (entries.some((entry) => !entry)) throw invalid("--array contains an empty index expression.");
  let taskCount = 0;
  for (const entry of entries) {
    const match = /^(\d+)(?:-(\d+)(?::([1-9]\d*))?)?$/.exec(entry);
    if (!match) throw invalid("--array contains an invalid index expression.");
    const start = parseNonNegativeSafeInteger(match[1]!, "Array index");
    const end = match[2] === undefined ? start : parseNonNegativeSafeInteger(match[2], "Array index");
    const step = match[3] === undefined ? 1 : parsePositiveInteger(match[3], "Array step");
    if (end < start) throw invalid("--array range end must not be smaller than its start.");
    const count = Math.floor((end - start) / step) + 1;
    if (!Number.isSafeInteger(taskCount + count)) throw invalid("--array task count is too large.");
    taskCount += count;
    if (taskCount > policy.maxArrayTasks) {
      throw policyDenied("RESOURCE_LIMIT_EXCEEDED", `array tasks exceed policy maximum ${policy.maxArrayTasks}.`);
    }
  }
  const concurrency = throttleParts[1] === undefined
    ? taskCount
    : parsePositiveInteger(throttleParts[1], "Array concurrency");
  if (concurrency > policy.maxArrayConcurrency) {
    throw policyDenied(
      "RESOURCE_LIMIT_EXCEEDED",
      `array concurrency exceeds policy maximum ${policy.maxArrayConcurrency}; add or lower the %CONCURRENCY limit.`,
    );
  }
  return { value, taskCount, concurrency };
}

export function validateDependency(value: string | undefined, policy: Policy): {
  value?: string; jobIds?: string[]; types?: string[];
} {
  if (value === undefined) return {};
  if (!value || value.includes("?")) {
    throw invalid("--dependency must contain comma-separated AND conditions.");
  }
  const jobIds: string[] = [];
  const types: string[] = [];
  const clauses = value.split(",");
  if (clauses.some((clause) => !clause)) throw invalid("--dependency contains an empty condition.");
  if (clauses.length > policy.maxDependencyJobs) {
    throw policyDenied(
      "RESOURCE_LIMIT_EXCEEDED",
      `dependency conditions exceed policy maximum ${policy.maxDependencyJobs}.`,
    );
  }
  for (const clause of clauses) {
    if (clause === "singleton") {
      if (!policy.allowedDependencyTypes.includes("singleton")) {
        throw policyDenied("DEPENDENCY_TYPE_NOT_ALLOWED", "Dependency type singleton is not permitted.");
      }
      types.push("singleton");
      continue;
    }
    const separator = clause.indexOf(":");
    const type = separator < 0 ? clause : clause.slice(0, separator);
    const references = separator < 0 ? [] : clause.slice(separator + 1).split(":");
    if (!policy.allowedDependencyTypes.includes(type)) {
      throw policyDenied("DEPENDENCY_TYPE_NOT_ALLOWED", `Dependency type ${type || "(empty)"} is not permitted.`);
    }
    if (type === "singleton" || references.length === 0 || references.some((reference) => !reference)) {
      throw invalid(`Dependency type ${type} requires one or more job IDs.`);
    }
    types.push(type);
    for (const reference of references) {
      const jobId = validateJobId(reference);
      if (type === "aftercorr" && jobId.includes("_")) {
        throw invalid("aftercorr must reference an array job ID, not an individual array task.");
      }
      jobIds.push(jobId);
      if (jobIds.length > policy.maxDependencyJobs) {
        throw policyDenied(
          "RESOURCE_LIMIT_EXCEEDED",
          `dependency job references exceed policy maximum ${policy.maxDependencyJobs}.`,
        );
      }
    }
  }
  return { value, jobIds: [...new Set(jobIds)], types: [...new Set(types)] };
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
  if (options.gpus !== undefined && options.gres !== undefined) {
    throw invalid("--gpus and --gres are mutually exclusive.");
  }
  if (options.gpus !== undefined) {
    if (!Number.isInteger(options.gpus) || options.gpus < 1) throw invalid("--gpus must be a positive integer.");
    if (options.gpus > policy.maxGpus) {
      throw policyDenied("RESOURCE_LIMIT_EXCEEDED", `gpus exceeds policy maximum ${policy.maxGpus}.`);
    }
  }
  const gresValue = resolveGresAlias(options.gres, policy.allowedGres);
  const array = validateArray(options.array, policy);
  const dependency = validateDependency(options.dependency, policy);
  if (dependency.types?.includes("aftercorr") && !options.array) {
    throw invalid("aftercorr requires the submitted job to use --array.");
  }
  if (dependency.types?.includes("singleton") && !options.jobName) {
    throw invalid("singleton requires an explicit --job-name.");
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
  return {
    ...options, memoryGb, timeMinutes, apptainerImagePath, venvPath, gresValue,
    arrayTaskCount: array.taskCount, arrayConcurrency: array.concurrency,
    dependencyJobIds: dependency.jobIds,
  };
}

export function validateJobId(value: string): string {
  if (!/^[1-9]\d*(?:_\d+)?$/.test(value)) {
    throw invalid("Job ID must be a decimal job ID or array task ID such as 12345_7.", "INVALID_JOB_ID");
  }
  return value;
}
