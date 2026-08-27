import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { AgentError, ExitCode } from "../errors/errors.js";
import type { Policy } from "./types.js";

const keys = [
  "allowed_partitions", "max_nodes", "max_ntasks", "max_cpus_per_task",
  "max_memory_gb", "max_time_minutes", "max_log_lines", "max_log_bytes",
] as const;

function positive(value: unknown, key: string, defaultValue?: number): number {
  const resolved = value ?? defaultValue;
  if (!Number.isInteger(resolved) || (resolved as number) <= 0) {
    throw new AgentError("CONFIGURATION_ERROR", `${key} must be a positive integer.`, ExitCode.General);
  }
  return resolved as number;
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
    maxTimeMinutes: positive(data.max_time_minutes, "max_time_minutes"),
    maxLogLines: positive(data.max_log_lines, "max_log_lines", 1000),
    maxLogBytes: positive(data.max_log_bytes, "max_log_bytes", 1048576),
  };
}
