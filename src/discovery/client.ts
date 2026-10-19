import { stripVTControlCharacters } from "node:util";
import { AgentError, ExitCode } from "../errors/errors.js";
import { parseClusterInfo } from "../slurm/parser.js";
import type { PartitionInfo } from "../slurm/types.js";
import type { RemoteExecutor, RemoteResult, TrustedRemoteExecutablePath } from "../transport/types.js";
import type {
  AssociationDiscovery, DiscoveryNodeInfo, ReservationDiscovery, RuntimeDiscovery,
} from "./types.js";

const MAX_DISCOVERY_OUTPUT_BYTES = 1048576;
const moduleNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9_.+-]{0,127})*$/;

function failed(result: RemoteResult, message: string): never {
  throw new AgentError("DISCOVERY_FAILED", message, ExitCode.General, { remote_exit_code: result.exitCode });
}

function trustedExecutable(path: string, label: string): TrustedRemoteExecutablePath {
  if (!/^\/[A-Za-z0-9_./+-]+$/.test(path) || path.split("/").includes("..")) {
    throw new AgentError("DISCOVERY_FAILED", `${label} resolved to an unsafe path.`, ExitCode.General);
  }
  return path as TrustedRemoteExecutablePath;
}

export function parseModuleCatalog(output: string): string[] {
  const modules = new Set<string>();
  const sanitized = stripVTControlCharacters(output).replace(/\r/g, "");
  for (const rawLine of sanitized.split("\n")) {
    let line = rawLine.trim();
    if (!line || line.endsWith(":") || /^-+$/.test(line)) continue;
    line = line.replace(/(?:\s+<[^>]+>)+\s*$/, "").trim();
    line = line.replace(/\s*\((?:D|L|S|default)\)\s*$/i, "").trim();
    const alias = /^([A-Za-z0-9][A-Za-z0-9_.+-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.+-]*)*)\(@/.exec(line);
    if (alias) line = alias[1]!;
    if (line.endsWith("/")) continue;
    if (moduleNamePattern.test(line)) modules.add(line);
  }
  return [...modules].sort((left, right) => left.localeCompare(right));
}

export function parseAssociations(output: string): AssociationDiscovery[] {
  const seen = new Set<string>();
  const associations: AssociationDiscovery[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [account = "", partitionText = "", qosText = "", defaultQos = ""] = line.split("|");
    if (!/^[A-Za-z0-9_.-]+$/.test(account)) continue;
    const partitions = partitionText.split(",").filter((entry) => /^[A-Za-z0-9_.-]+$/.test(entry));
    const qos = qosText.split(",").filter((entry) => /^[A-Za-z0-9_.-]+$/.test(entry));
    const key = JSON.stringify([account, partitions, qos, defaultQos]);
    if (seen.has(key)) continue;
    seen.add(key);
    associations.push({
      account,
      partitions,
      qos,
      ...(/^[A-Za-z0-9_.-]+$/.test(defaultQos) ? { default_qos: defaultQos } : {}),
    });
  }
  return associations;
}

export function parseReservations(output: string): ReservationDiscovery[] {
  const reservations: ReservationDiscovery[] = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = new Map<string, string>();
    for (const match of line.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9]*)=([^\s]*)/g)) {
      fields.set(match[1]!, match[2]!);
    }
    const name = fields.get("ReservationName");
    if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) continue;
    const list = (key: string): string[] => (fields.get(key) ?? "")
      .split(",")
      .filter((entry) => entry && /^[A-Za-z0-9_.@+*-]+$/.test(entry));
    reservations.push({
      name,
      partitions: list("PartitionName"),
      accounts: list("Accounts"),
      users: list("Users"),
      ...(fields.get("State") ? { state: fields.get("State") } : {}),
      ...(fields.get("StartTime") ? { start_time: fields.get("StartTime") } : {}),
      ...(fields.get("EndTime") ? { end_time: fields.get("EndTime") } : {}),
      flags: list("Flags"),
    });
  }
  return reservations;
}

function parseNonNegativeInteger(value: string, context: string): number {
  if (!/^\d+$/.test(value)) {
    throw new AgentError("DISCOVERY_FAILED", `Unexpected ${context} output.`, ExitCode.General);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new AgentError("DISCOVERY_FAILED", `Unexpected ${context} output.`, ExitCode.General);
  }
  return parsed;
}

function splitSlurmList(value: string): string[] {
  if (!value || ["N/A", "(null)", "None", "Unknown"].includes(value)) return [];
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    else if (value[index] === ")" && depth > 0) depth -= 1;
    else if (value[index] === "," && depth === 0) {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  return entries.filter(Boolean);
}

export function parseDiscoveryNodes(output: string): DiscoveryNodeInfo[] {
  return output.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const fields = line.split("|").map((field) => field.trim());
    const nodeName = fields[0] ?? "";
    const partition = (fields[1] ?? "").replace(/\*$/, "");
    if (fields.length !== 7 || !/^[A-Za-z0-9_.-]+$/.test(nodeName) ||
        !/^[A-Za-z0-9_.-]+$/.test(partition)) {
      throw new AgentError("DISCOVERY_FAILED", "Unexpected sinfo node discovery output.", ExitCode.General);
    }
    return {
      node_name: nodeName,
      partition,
      state: fields[2]!,
      cpus: { total: parseNonNegativeInteger(fields[3]!, "sinfo CPU count") },
      memory: { total_mib: parseNonNegativeInteger(fields[4]!, "sinfo memory") },
      gres: splitSlurmList(fields[5]!),
      features: splitSlurmList(fields[6]!),
    };
  });
}

export class DiscoveryClient {
  constructor(
    private readonly executor: RemoteExecutor,
    private readonly user: string,
    private readonly remoteApptainerPath: string,
    private readonly remoteSrunPath: string,
    private readonly remoteModulecmdPath: string,
  ) {}

  private async runtime(path: string): Promise<RuntimeDiscovery> {
    const resolved = await this.executor.run({ executable: "realpath", args: ["-e", "--", path] });
    const resolvedPath = resolved.exitCode === 0 ? resolved.stdout.trim() : undefined;
    if (!resolvedPath) return { configured_path: path, available: false, executable: false };
    trustedExecutable(resolvedPath, "Runtime executable");
    const executable = await this.executor.run({ executable: "test", args: ["-x", resolvedPath] });
    return {
      configured_path: path,
      resolved_path: resolvedPath,
      available: true,
      executable: executable.exitCode === 0,
    };
  }

  async cluster(): Promise<{ partitions: PartitionInfo[]; nodes: DiscoveryNodeInfo[] }> {
    const partitions = await this.executor.run({
      executable: "sinfo",
      args: ["--noheader", "--format=%P|%a|%l|%D|%t|%C|%G"],
      maxOutputBytes: MAX_DISCOVERY_OUTPUT_BYTES,
    });
    if (partitions.exitCode !== 0) failed(partitions, "Unable to discover Slurm partitions.");
    if (partitions.stdoutTruncated) failed(partitions, "Slurm partition discovery exceeded the safe output limit.");
    const nodes = await this.executor.run({
      executable: "sinfo",
      args: [
        "--noheader", "--Node",
        "--format=%N|%P|%T|%c|%m|%G|%f",
      ],
      maxOutputBytes: MAX_DISCOVERY_OUTPUT_BYTES,
    });
    if (nodes.exitCode !== 0) failed(nodes, "Unable to discover Slurm nodes.");
    if (nodes.stdoutTruncated) failed(nodes, "Slurm node discovery exceeded the safe output limit.");
    return { partitions: parseClusterInfo(partitions.stdout), nodes: parseDiscoveryNodes(nodes.stdout) };
  }

  async modules(): Promise<{ modules: string[] }> {
    const runtime = await this.runtime(this.remoteModulecmdPath);
    if (!runtime.executable || !runtime.resolved_path) {
      throw new AgentError("DISCOVERY_FAILED", "Configured modulecmd executable is unavailable.", ExitCode.General);
    }
    const result = await this.executor.run({
      executable: trustedExecutable(runtime.resolved_path, "modulecmd executable"),
      args: ["bash", "--no_redirect", "-t", "avail"],
      maxOutputBytes: MAX_DISCOVERY_OUTPUT_BYTES,
    });
    if (result.exitCode !== 0) failed(result, "Unable to discover environment modules.");
    if (result.stdoutTruncated || result.stderrTruncated) {
      failed(result, "Environment module discovery exceeded the safe output limit.");
    }
    return { modules: parseModuleCatalog(result.stderr || result.stdout) };
  }

  async associations(): Promise<Record<string, unknown>> {
    const warnings: string[] = [];
    const associationResult = await this.executor.run({
      executable: "sacctmgr",
      args: [
        "--noheader", "--parsable2", "show", "associations", "where", `user=${this.user}`,
        "format=Account,Partition,QOS,DefaultQOS",
      ],
      maxOutputBytes: MAX_DISCOVERY_OUTPUT_BYTES,
    });
    let associations: AssociationDiscovery[] = [];
    if (associationResult.exitCode === 0 && !associationResult.stdoutTruncated) {
      associations = parseAssociations(associationResult.stdout);
    } else {
      warnings.push("Slurm associations are unavailable to the configured SSH user.");
    }
    const reservationResult = await this.executor.run({
      executable: "scontrol", args: ["--oneliner", "show", "reservation"],
      maxOutputBytes: MAX_DISCOVERY_OUTPUT_BYTES,
    });
    let reservations: ReservationDiscovery[] = [];
    if (reservationResult.exitCode === 0 && !reservationResult.stdoutTruncated) {
      reservations = parseReservations(reservationResult.stdout);
    } else {
      warnings.push("Slurm reservations are unavailable to the configured SSH user.");
    }
    return {
      user: this.user,
      associations,
      accounts: [...new Set(associations.map((entry) => entry.account))].sort(),
      qos: [...new Set(associations.flatMap((entry) => entry.qos))].sort(),
      reservations,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  async runtimes(): Promise<Record<string, RuntimeDiscovery>> {
    const apptainer = await this.runtime(this.remoteApptainerPath);
    const srun = await this.runtime(this.remoteSrunPath);
    const modulecmd = await this.runtime(this.remoteModulecmdPath);
    return { apptainer, srun, modulecmd };
  }
}
