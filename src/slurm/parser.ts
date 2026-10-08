import { AgentError, ExitCode } from "../errors/errors.js";
import { resolveWorkspacePath } from "../policy/path.js";
import type {
  ArtifactEntry, FairShareEntry, JobSummary, JobUsage, NodeInfo, OwnedHistoryJob, OwnedJob, PartitionInfo, UsageStep,
} from "./types.js";

function rows(output: string): string[][] {
  return output.split(/\r?\n/).filter((line) => line.trim()).map((line) => line.split("|"));
}

function optionalText(value: string): string | undefined {
  return value && !["N/A", "(null)", "None", "Unknown"].includes(value) ? value : undefined;
}

function optionalCount(value: string, context: string): number | undefined {
  if (!optionalText(value)) return undefined;
  if (!/^\d+$/.test(value)) throw new AgentError("SLURM_QUERY_FAILED", `Unexpected ${context} output.`, ExitCode.SlurmFailure);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new AgentError("SLURM_QUERY_FAILED", `Unexpected ${context} output.`, ExitCode.SlurmFailure);
  return parsed;
}

function queueDetails(fields: string[], offset: number): Partial<JobSummary> {
  const details: Partial<JobSummary> = {};
  const values: Array<[keyof JobSummary, string | number | undefined]> = [
    ["reason", optionalText(fields[offset]!)],
    ["priority", optionalCount(fields[offset + 1]!, "squeue priority")],
    ["start_time", optionalText(fields[offset + 2]!)],
    ["submit_time", optionalText(fields[offset + 3]!)],
    ["time_limit", optionalText(fields[offset + 4]!)],
    ["time_left", optionalText(fields[offset + 5]!)],
    ["node_list", optionalText(fields[offset + 6]!)],
    ["nodes", optionalCount(fields[offset + 7]!, "squeue node count")],
    ["cpus", optionalCount(fields[offset + 8]!, "squeue CPU count")],
    ["account", optionalText(fields[offset + 9]!)],
    ["qos", optionalText(fields[offset + 10]!)],
    ["reservation", optionalText(fields[offset + 11]!)],
  ];
  for (const [key, value] of values) if (value !== undefined) Object.assign(details, { [key]: value });
  return details;
}

export function parseQueueList(output: string): JobSummary[] {
  return rows(output).map((fields) => {
    if (fields.length !== 5 && fields.length !== 17) {
      throw new AgentError("SLURM_QUERY_FAILED", "Unexpected squeue output.", ExitCode.SlurmFailure);
    }
    return {
      job_id: fields[0]!, name: fields[1]!, partition: fields[2]!, state: fields[3]!, elapsed: fields[4]!,
      ...(fields.length === 17 ? queueDetails(fields, 5) : {}),
    };
  });
}

export function parseQueueJob(output: string): OwnedJob | undefined {
  return parseQueueJobs(output)[0];
}

export function parseQueueJobs(output: string): OwnedJob[] {
  return rows(output).map((fields) => {
    if (fields.length !== 6 && fields.length !== 18) {
      throw new AgentError("SLURM_QUERY_FAILED", "Unexpected squeue output.", ExitCode.SlurmFailure);
    }
    return {
      job_id: fields[0]!, user: fields[1]!, name: fields[2]!, partition: fields[3]!, state: fields[4]!, elapsed: fields[5]!,
      ...(fields.length === 18 ? queueDetails(fields, 6) : {}),
    };
  });
}

export function parseAccountingJob(output: string, requestedId: string): OwnedJob | undefined {
  return parseAccountingJobs(output).find((job) => job.job_id === requestedId);
}

export function parseAccountingJobs(output: string): OwnedJob[] {
  return rows(output).map((fields) => {
    if (fields.length !== 7 && fields.length !== 18) {
      throw new AgentError("SLURM_QUERY_FAILED", "Unexpected sacct output.", ExitCode.SlurmFailure);
    }
    const job: OwnedJob = {
      job_id: fields[0]!, user: fields[1]!, name: fields[2]!, partition: fields[3]!,
      state: fields[4]!, elapsed: fields[5]!, exit_code: fields[6]!,
    };
    if (fields.length === 18) {
      const values: Array<[keyof JobSummary, string | number | undefined]> = [
        ["reason", optionalText(fields[7]!)],
        ["priority", optionalCount(fields[8]!, "sacct priority")],
        ["start_time", optionalText(fields[9]!)],
        ["submit_time", optionalText(fields[10]!)],
        ["time_limit", optionalText(fields[11]!)],
        ["node_list", optionalText(fields[12]!)],
        ["nodes", optionalCount(fields[13]!, "sacct node count")],
        ["cpus", optionalCount(fields[14]!, "sacct CPU count")],
        ["account", optionalText(fields[15]!)],
        ["qos", optionalText(fields[16]!)],
        ["reservation", optionalText(fields[17]!)],
      ];
      for (const [key, value] of values) if (value !== undefined) Object.assign(job, { [key]: value });
    }
    return job;
  });
}

export function parseSubmittedJobId(output: string): string {
  const match = /^([1-9]\d*)(?:;[A-Za-z0-9_.-]+)?$/.exec(output.trim());
  if (!match) {
    throw new AgentError("SLURM_SUBMIT_FAILED", "sbatch returned an invalid job ID.", ExitCode.SlurmFailure);
  }
  return match[1]!;
}

function parseNonNegativeInteger(value: string): number {
  if (!/^\d+$/.test(value)) throw new AgentError("SLURM_QUERY_FAILED", "Unexpected sinfo output.", ExitCode.SlurmFailure);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new AgentError("SLURM_QUERY_FAILED", "Unexpected sinfo output.", ExitCode.SlurmFailure);
  return parsed;
}

export function parseClusterInfo(output: string): PartitionInfo[] {
  return rows(output).map((fields) => {
    if (fields.length !== 7) throw new AgentError("SLURM_QUERY_FAILED", "Unexpected sinfo output.", ExitCode.SlurmFailure);
    const cpuFields = fields[5]!.split("/");
    if (cpuFields.length !== 4) throw new AgentError("SLURM_QUERY_FAILED", "Unexpected sinfo CPU summary.", ExitCode.SlurmFailure);
    return {
      partition: fields[0]!.replace(/\*$/, ""),
      availability: fields[1]!,
      time_limit: fields[2]!,
      nodes: parseNonNegativeInteger(fields[3]!),
      node_state: fields[4]!,
      cpus: {
        allocated: parseNonNegativeInteger(cpuFields[0]!),
        idle: parseNonNegativeInteger(cpuFields[1]!),
        other: parseNonNegativeInteger(cpuFields[2]!),
        total: parseNonNegativeInteger(cpuFields[3]!),
      },
      gres: fields[6] === "(null)" ? [] : fields[6]!.split(",").filter(Boolean),
    };
  });
}

export function parseNodeInfo(output: string): NodeInfo[] {
  return rows(output).map((fields) => {
    if (fields.length !== 6 || !/^[A-Za-z0-9_.-]+$/.test(fields[0]!)) {
      throw new AgentError("SLURM_QUERY_FAILED", "Unexpected sinfo node output.", ExitCode.SlurmFailure);
    }
    const partition = fields[1]!.replace(/\*$/, "");
    if (!/^[A-Za-z0-9_.-]+$/.test(partition)) {
      throw new AgentError("SLURM_QUERY_FAILED", "Unexpected sinfo node output.", ExitCode.SlurmFailure);
    }
    const cpuFields = fields[4]!.split("/");
    if (cpuFields.length !== 4) {
      throw new AgentError("SLURM_QUERY_FAILED", "Unexpected sinfo node CPU summary.", ExitCode.SlurmFailure);
    }
    return {
      node_name: fields[0]!,
      partition,
      availability: fields[2]!,
      state: fields[3]!,
      cpus: {
        allocated: parseNonNegativeInteger(cpuFields[0]!),
        idle: parseNonNegativeInteger(cpuFields[1]!),
        other: parseNonNegativeInteger(cpuFields[2]!),
        total: parseNonNegativeInteger(cpuFields[3]!),
      },
      gres: fields[5] === "(null)" ? [] : fields[5]!.split(",").filter(Boolean),
    };
  });
}

function parseCount(value: string, context: string): number {
  if (!/^\d+$/.test(value)) throw new AgentError("SLURM_QUERY_FAILED", `Unexpected ${context} output.`, ExitCode.SlurmFailure);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new AgentError("SLURM_QUERY_FAILED", `Unexpected ${context} output.`, ExitCode.SlurmFailure);
  return parsed;
}

export function parseHistory(output: string): OwnedHistoryJob[] {
  return rows(output).map((fields) => {
    if (fields.length !== 13) throw new AgentError("SLURM_QUERY_FAILED", "Unexpected sacct history output.", ExitCode.SlurmFailure);
    return {
      job_id: fields[0]!, user: fields[1]!, name: fields[2]!, partition: fields[3]!, state: fields[4]!,
      elapsed: fields[5]!, start: fields[6]!, end: fields[7]!, exit_code: fields[8]!,
      allocated_cpus: parseCount(fields[9]!, "sacct history"),
      allocated_nodes: parseCount(fields[10]!, "sacct history"),
      requested_memory: fields[11]!, requested_tres: fields[12]!,
    };
  });
}

interface AccountingUsageRow {
  stepId: string;
  user: string;
  name: string;
  partition: string;
  state: string;
  elapsed: string;
  elapsedSeconds: number;
  allocatedCpus: number;
  allocatedNodes: number;
  requestedMemory: string;
  requestedTres: string;
  allocatedTres: string;
  totalCpu: string;
  maxRss: string;
  maxVmSize: string;
  maxDiskRead: string;
  maxDiskWrite: string;
  exitCode: string;
}

function parseUsageRows(output: string): AccountingUsageRow[] {
  return rows(output).map((fields) => {
    if (fields.length !== 18) throw new AgentError("SLURM_QUERY_FAILED", "Unexpected sacct usage output.", ExitCode.SlurmFailure);
    return {
      stepId: fields[0]!, user: fields[1]!, name: fields[2]!, partition: fields[3]!, state: fields[4]!,
      elapsed: fields[5]!, elapsedSeconds: parseCount(fields[6]!, "sacct usage"),
      allocatedCpus: parseCount(fields[7]!, "sacct usage"),
      allocatedNodes: parseCount(fields[8]!, "sacct usage"),
      requestedMemory: fields[9]!, requestedTres: fields[10]!, allocatedTres: fields[11]!,
      totalCpu: fields[12]!, maxRss: fields[13]!, maxVmSize: fields[14]!,
      maxDiskRead: fields[15]!, maxDiskWrite: fields[16]!, exitCode: fields[17]!,
    };
  });
}

function parseDurationSeconds(value: string): number | undefined {
  if (!value) return undefined;
  const dayParts = value.split("-");
  if (dayParts.length > 2) return undefined;
  if (dayParts.length === 2 && !/^\d+$/.test(dayParts[0]!)) return undefined;
  const days = dayParts.length === 2 ? Number(dayParts[0]) : 0;
  const clock = dayParts.length === 2 ? dayParts[1]! : dayParts[0]!;
  const parts = clock.split(":");
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return undefined;
  const seconds = Number(parts.at(-1));
  const minutes = parts.length >= 2 ? Number(parts.at(-2)) : 0;
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (!Number.isFinite(seconds) || minutes >= 60 || seconds >= 60) return undefined;
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function parseBytes(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([KMGTP]?)$/i.exec(value);
  if (!match) return undefined;
  const powers: Record<string, number> = { "": 0, K: 1, M: 2, G: 3, T: 4, P: 5 };
  const amount = Number(match[1]);
  const power = powers[match[2]!.toUpperCase()];
  if (power === undefined || !Number.isFinite(amount)) return undefined;
  return amount * 1024 ** power;
}

function requestedMemoryBytes(value: string, allocatedCpus: number, allocatedNodes: number): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([KMGTP]?)([cn]?)$/i.exec(value);
  if (!match) return undefined;
  const base = parseBytes(`${match[1]}${match[2]}`);
  if (base === undefined) return undefined;
  const scope = match[3]!.toLowerCase();
  if (scope === "c") return base * allocatedCpus;
  if (scope === "n") return base * allocatedNodes;
  return base;
}

function maximumMetric(accountingRows: AccountingUsageRow[], select: (row: AccountingUsageRow) => string): { raw: string; bytes?: number } {
  let result: { raw: string; bytes?: number } = { raw: "" };
  for (const row of accountingRows) {
    const raw = select(row);
    const bytes = parseBytes(raw);
    if (bytes !== undefined && (result.bytes === undefined || bytes > result.bytes)) result = { raw, bytes };
  }
  return result;
}

function percentage(numerator: number, denominator: number): number | undefined {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return undefined;
  return Math.round((numerator / denominator) * 10000) / 100;
}

export function parseJobUsage(output: string, requestedId: string): { user: string; usage: JobUsage } | undefined {
  const accountingRows = parseUsageRows(output);
  const allocation = accountingRows.find((row) => row.stepId === requestedId);
  if (!allocation) return undefined;
  const jobRows = accountingRows.filter((row) => row.stepId === requestedId || row.stepId.startsWith(`${requestedId}.`));
  const maxRss = maximumMetric(jobRows, (row) => row.maxRss);
  const maxVmSize = maximumMetric(jobRows, (row) => row.maxVmSize);
  const maxDiskRead = maximumMetric(jobRows, (row) => row.maxDiskRead);
  const maxDiskWrite = maximumMetric(jobRows, (row) => row.maxDiskWrite);
  const totalCpuSeconds = parseDurationSeconds(allocation.totalCpu)
    ?? jobRows.slice(1).reduce((total, row) => total + (parseDurationSeconds(row.totalCpu) ?? 0), 0);
  const requestedBytes = requestedMemoryBytes(
    allocation.requestedMemory, allocation.allocatedCpus, allocation.allocatedNodes,
  );
  const cpuEfficiency = percentage(totalCpuSeconds, allocation.elapsedSeconds * allocation.allocatedCpus);
  const memoryEfficiency = maxRss.bytes === undefined || requestedBytes === undefined
    ? undefined
    : percentage(maxRss.bytes, requestedBytes);
  const steps: UsageStep[] = jobRows.slice(1).map((row) => ({
    step_id: row.stepId, state: row.state, elapsed: row.elapsed, elapsed_seconds: row.elapsedSeconds,
    total_cpu: row.totalCpu, max_rss: row.maxRss, max_vm_size: row.maxVmSize,
    max_disk_read: row.maxDiskRead, max_disk_write: row.maxDiskWrite, allocated_tres: row.allocatedTres,
  }));
  const usage: JobUsage = {
    job_id: allocation.stepId, name: allocation.name, partition: allocation.partition,
    state: allocation.state, elapsed: allocation.elapsed, elapsed_seconds: allocation.elapsedSeconds,
    allocated_cpus: allocation.allocatedCpus, allocated_nodes: allocation.allocatedNodes,
    requested_memory: allocation.requestedMemory, requested_tres: allocation.requestedTres,
    allocated_tres: allocation.allocatedTres, total_cpu: allocation.totalCpu,
    max_rss: maxRss.raw, max_vm_size: maxVmSize.raw, max_disk_read: maxDiskRead.raw,
    max_disk_write: maxDiskWrite.raw, exit_code: allocation.exitCode,
    steps, live_available: false, live_steps: [],
  };
  if (cpuEfficiency !== undefined) usage.cpu_efficiency_percent = cpuEfficiency;
  if (memoryEfficiency !== undefined) usage.memory_efficiency_percent = memoryEfficiency;
  return { user: allocation.user, usage };
}

export function parseLiveUsage(output: string): UsageStep[] {
  return rows(output).map((fields) => {
    if (fields.length !== 7) throw new AgentError("SLURM_QUERY_FAILED", "Unexpected sstat output.", ExitCode.SlurmFailure);
    return {
      step_id: fields[0]!, average_cpu: fields[1]!, max_rss: fields[2]!, max_vm_size: fields[3]!,
      max_disk_read: fields[4]!, max_disk_write: fields[5]!, allocated_tres: fields[6]!,
    };
  });
}

export function parseFairShare(output: string): FairShareEntry[] {
  return rows(output).map((fields) => {
    if (fields.length !== 10) {
      throw new AgentError("SLURM_QUERY_FAILED", "Unexpected sshare output.", ExitCode.SlurmFailure);
    }
    return {
      account: fields[0]!, user: fields[1]!, raw_shares: fields[2]!, normalized_shares: fields[3]!,
      raw_usage: fields[4]!, effective_usage: fields[5]!, fair_share: fields[6]!,
      level_fair_share: fields[7]!, group_tres_minutes: fields[8]!, tres_run_minutes: fields[9]!,
    };
  });
}

export function parseArtifactList(output: string, maxFiles: number): ArtifactEntry[] {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  if (tokens.length % 2 !== 0) {
    throw new AgentError("SLURM_QUERY_FAILED", "Unexpected artifact listing output.", ExitCode.SlurmFailure);
  }
  const entries: ArtifactEntry[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const path = tokens[index]!;
    const sizeText = tokens[index + 1]!;
    let safePath: string;
    try {
      safePath = resolveWorkspacePath("/artifact", path).slice("/artifact/".length);
    } catch {
      continue;
    }
    if (!/^\d+$/.test(sizeText)) {
      throw new AgentError("SLURM_QUERY_FAILED", "Unexpected artifact size output.", ExitCode.SlurmFailure);
    }
    const bytes = Number(sizeText);
    if (!Number.isSafeInteger(bytes)) {
      throw new AgentError("SLURM_QUERY_FAILED", "Unexpected artifact size output.", ExitCode.SlurmFailure);
    }
    entries.push({ path: safePath, bytes });
    if (entries.length > maxFiles) {
      throw new AgentError(
        "ARTIFACT_LIST_TOO_LARGE", `Artifact listing exceeds policy maximum ${maxFiles} files.`, ExitCode.PolicyDenied,
      );
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}
