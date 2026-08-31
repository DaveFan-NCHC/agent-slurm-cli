import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { parse } from "yaml";
import { AgentError, ExitCode } from "../errors/errors.js";
import type { Policy } from "./types.js";

const keys = [
  "allowed_partitions", "max_nodes", "max_ntasks", "max_cpus_per_task",
  "max_memory_gb", "max_gpus", "max_time_minutes", "max_wait_seconds", "max_log_lines", "max_log_bytes",
  "max_artifact_bytes", "allowed_apptainer_images", "allowed_virtualenvs", "allowed_gres",
  "max_script_bytes", "max_script_args", "max_script_arg_length",
  "require_apptainer_for_generated_scripts",
] as const;

const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const fixedPathPattern = /^\/[A-Za-z0-9_./+-]+$/;

function positive(value: unknown, key: string, defaultValue?: number): number {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || (resolved as number) <= 0) {
    throw new AgentError("CONFIGURATION_ERROR", `${key} must be a positive integer.`, ExitCode.General);
  }
  return resolved as number;
}

function nonNegative(value: unknown, key: string, defaultValue: number): number {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || (resolved as number) < 0) {
    throw new AgentError("CONFIGURATION_ERROR", `${key} must be a non-negative integer.`, ExitCode.General);
  }
  return resolved as number;
}

function fixedPathMap(value: unknown, key: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentError("CONFIGURATION_ERROR", `${key} must be a mapping of aliases to absolute paths.`, ExitCode.General);
  }
  const result: Record<string, string> = {};
  for (const [alias, path] of Object.entries(value as Record<string, unknown>)) {
    if (!aliasPattern.test(alias)) {
      throw new AgentError("CONFIGURATION_ERROR", `${key} contains an invalid alias.`, ExitCode.General);
    }
    if (typeof path !== "string" || !posix.isAbsolute(path) || !fixedPathPattern.test(path) || path.split("/").includes("..")) {
      throw new AgentError("CONFIGURATION_ERROR", `${key}.${alias} must be a safe absolute POSIX path.`, ExitCode.General);
    }
    result[alias] = path;
  }
  return result;
}

function gresMap(value: unknown, key: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentError("CONFIGURATION_ERROR", `${key} must be a mapping of aliases to GRES requests.`, ExitCode.General);
  }
  const result: Record<string, string> = {};
  for (const [alias, request] of Object.entries(value as Record<string, unknown>)) {
    if (!aliasPattern.test(alias)) {
      throw new AgentError("CONFIGURATION_ERROR", `${key} contains an invalid alias.`, ExitCode.General);
    }
    const entries = typeof request === "string" ? request.split(",") : [];
    if (entries.length === 0 || entries.some((entry) => !/^[A-Za-z0-9_.-]+:(?:[A-Za-z0-9_.-]+:)?[1-9]\d*$/.test(entry))) {
      throw new AgentError("CONFIGURATION_ERROR", `${key}.${alias} must be a safe GRES request.`, ExitCode.General);
    }
    result[alias] = request as string;
  }
  return result;
}

function booleanValue(value: unknown, key: string, defaultValue: boolean): boolean {
  const resolved = value ?? defaultValue;
  if (typeof resolved !== "boolean") {
    throw new AgentError("CONFIGURATION_ERROR", `${key} must be true or false.`, ExitCode.General);
  }
  return resolved;
}

export function loadPolicy(path: string): Policy {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new AgentError("CONFIGURATION_ERROR", `Unable to load policy: ${(cause as Error).message}`, ExitCode.General);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentError("CONFIGURATION_ERROR", "Policy must be a YAML mapping.", ExitCode.General);
  }
  const data = raw as Record<string, unknown>;
  const unknown = Object.keys(data).filter((key) => !keys.includes(key as (typeof keys)[number]));
  if (unknown.length) {
    throw new AgentError("CONFIGURATION_ERROR", `Unknown policy key(s): ${unknown.join(", ")}.`, ExitCode.General);
  }
  if (!Array.isArray(data.allowed_partitions) || data.allowed_partitions.length === 0 ||
      data.allowed_partitions.some((v) => typeof v !== "string" || !/^[A-Za-z0-9_.-]+$/.test(v))) {
    throw new AgentError("CONFIGURATION_ERROR", "allowed_partitions must contain safe partition names.", ExitCode.General);
  }
  return {
    allowedPartitions: data.allowed_partitions as string[],
    maxNodes: positive(data.max_nodes, "max_nodes"),
    maxNtasks: positive(data.max_ntasks, "max_ntasks"),
    maxCpusPerTask: positive(data.max_cpus_per_task, "max_cpus_per_task"),
    maxMemoryGb: positive(data.max_memory_gb, "max_memory_gb"),
    maxGpus: nonNegative(data.max_gpus, "max_gpus", 0),
    maxTimeMinutes: positive(data.max_time_minutes, "max_time_minutes"),
    maxWaitSeconds: positive(data.max_wait_seconds, "max_wait_seconds", 86400),
    maxLogLines: positive(data.max_log_lines, "max_log_lines", 1000),
    maxLogBytes: positive(data.max_log_bytes, "max_log_bytes", 1048576),
    maxArtifactBytes: positive(data.max_artifact_bytes, "max_artifact_bytes", 104857600),
    allowedApptainerImages: fixedPathMap(data.allowed_apptainer_images, "allowed_apptainer_images"),
    allowedVirtualenvs: fixedPathMap(data.allowed_virtualenvs, "allowed_virtualenvs"),
    allowedGres: gresMap(data.allowed_gres, "allowed_gres"),
    maxScriptBytes: positive(data.max_script_bytes, "max_script_bytes", 65536),
    maxScriptArgs: positive(data.max_script_args, "max_script_args", 32),
    maxScriptArgLength: positive(data.max_script_arg_length, "max_script_arg_length", 1024),
    requireApptainerForGeneratedScripts: booleanValue(
      data.require_apptainer_for_generated_scripts,
      "require_apptainer_for_generated_scripts",
      true,
    ),
  };
}
