import { describe, expect, it } from "vitest";
import {
  DiscoveryClient, parseAssociations, parseDiscoveryNodes, parseModuleCatalog, parseReservations,
} from "../../src/discovery/client.js";
import type {
  ArtifactDownload, RemoteExecutor, RemoteResult, SafeArtifactBundleTransfer, SafeArtifactTransfer,
  SafeCommand, SafeSubmissionUpload,
} from "../../src/transport/types.js";

class MockExecutor implements RemoteExecutor {
  readonly commands: SafeCommand[] = [];
  constructor(private readonly results: RemoteResult[]) {}
  async run(command: SafeCommand): Promise<RemoteResult> {
    this.commands.push(command);
    const result = this.results.shift();
    if (!result) throw new Error("Missing mock result");
    return result;
  }
  async downloadArtifact(_transfer: SafeArtifactTransfer): Promise<ArtifactDownload> {
    throw new Error("not used");
  }
  async downloadArtifactBundle(_transfer: SafeArtifactBundleTransfer): Promise<ArtifactDownload> {
    throw new Error("not used");
  }
  async uploadSubmission(_upload: SafeSubmissionUpload): Promise<{ bytes: number }> {
    throw new Error("not used");
  }
  async close(): Promise<void> {}
}

const ok = (stdout = "", stderr = ""): RemoteResult => ({ stdout, stderr, exitCode: 0 });

describe("HPC discovery", () => {
  it("parses a terse module catalog and removes presentation markers", () => {
    expect(parseModuleCatalog([
      "/opt/modulefiles:",
      "gcc/12.2.0 (D)",
      "cuda/12.1",
      "openmpi/4.1 (L)",
      "hidden/1.0 <H>",
      "a13(@a/13.2.345)",
      "compiler/",
      "Where:",
      "D: Default Module",
    ].join("\n"))).toEqual(["a13", "cuda/12.1", "gcc/12.2.0", "hidden/1.0", "openmpi/4.1"]);
  });

  it("parses user associations and reservations", () => {
    expect(parseAssociations([
      "research|gpu|normal,debug|normal|",
      "research|cpu|normal|normal|",
    ].join("\n"))).toEqual([
      { account: "research", partitions: ["gpu"], qos: ["normal", "debug"], default_qos: "normal" },
      { account: "research", partitions: ["cpu"], qos: ["normal"], default_qos: "normal" },
    ]);
    expect(parseReservations(
      "ReservationName=workshop StartTime=2026-10-20T08:00:00 EndTime=2026-10-20T18:00:00 PartitionName=gpu Users=alice Accounts=research State=ACTIVE Flags=SPEC_NODES\n",
    )).toEqual([{
      name: "workshop", partitions: ["gpu"], accounts: ["research"], users: ["alice"],
      state: "ACTIVE", start_time: "2026-10-20T08:00:00", end_time: "2026-10-20T18:00:00",
      flags: ["SPEC_NODES"],
    }]);
  });

  it("discovers all Slurm-visible partitions and nodes without policy filters", async () => {
    const node = ["gpu01", "gpu*", "idle", "64", "515000", "gpu:h200:8", "zen4,h200"].join("|");
    const remote = new MockExecutor([
      ok("gpu*|up|1-00:00:00|1|idle|0/64/0/64|gpu:h200:8\n"),
      ok(`${node}\n`),
    ]);
    const client = new DiscoveryClient(
      remote, "alice", "/usr/bin/apptainer", "/usr/bin/srun", "/usr/bin/modulecmd",
    );
    const result = await client.cluster();
    expect(result.partitions[0]).toMatchObject({ partition: "gpu", nodes: 1 });
    expect(result.nodes[0]).toEqual({
      node_name: "gpu01", partition: "gpu", state: "idle", cpus: { total: 64 },
      memory: { total_mib: 515000 }, gres: ["gpu:h200:8"], features: ["zen4", "h200"],
    });
    expect(remote.commands[0]?.args).not.toEqual(expect.arrayContaining([expect.stringContaining("--partition=")]));
    expect(remote.commands[1]?.args).not.toEqual(expect.arrayContaining([expect.stringContaining("--partition=")]));
    expect(remote.commands[1]).toEqual({
      executable: "sinfo",
      args: ["--noheader", "--Node", "--format=%N|%P|%T|%c|%m|%G|%f"],
      maxOutputBytes: 1048576,
    });
  });

  it("parses compact node discovery without splitting commas inside GRES details", () => {
    expect(parseDiscoveryNodes(
      "gpu01|gpu*|mixed|64|515000|gpu:a100:2(IDX:0,1),nvme:1|zen4,a100\n",
    )).toEqual([{
      node_name: "gpu01", partition: "gpu", state: "mixed", cpus: { total: 64 },
      memory: { total_mib: 515000 }, gres: ["gpu:a100:2(IDX:0,1)", "nvme:1"],
      features: ["zen4", "a100"],
    }]);
  });

  it("rejects malformed compact node discovery rows", () => {
    expect(() => parseDiscoveryNodes("gpu01|gpu|idle|64|515000|gpu:a100:4\n"))
      .toThrowError(/Unexpected sinfo node discovery output/);
    expect(() => parseDiscoveryNodes("gpu01|gpu|idle|many|515000|gpu:a100:4|a100\n"))
      .toThrowError(/Unexpected sinfo CPU count output/);
  });

  it("discovers the live module catalog through the configured modulecmd", async () => {
    const remote = new MockExecutor([
      ok("/opt/lmod/libexec/lmod\n"), ok(),
      ok("", "/module/path:\ngcc/12.2.0 (D)\ncuda/12.1\n"),
    ]);
    const client = new DiscoveryClient(
      remote, "alice", "/usr/bin/apptainer", "/usr/bin/srun", "/opt/lmod/libexec/lmod",
    );
    await expect(client.modules()).resolves.toEqual({ modules: ["cuda/12.1", "gcc/12.2.0"] });
    expect(remote.commands[2]).toEqual({
      executable: "/opt/lmod/libexec/lmod",
      args: ["bash", "--no_redirect", "-t", "avail"],
      maxOutputBytes: 1048576,
    });
  });

  it("returns partial association discovery with warnings when optional data is unavailable", async () => {
    const remote = new MockExecutor([
      ok("research|gpu|normal,debug|normal|\n"),
      { stdout: "", stderr: "permission denied", exitCode: 1 },
    ]);
    const client = new DiscoveryClient(
      remote, "alice", "/usr/bin/apptainer", "/usr/bin/srun", "/usr/bin/modulecmd",
    );
    await expect(client.associations()).resolves.toMatchObject({
      user: "alice", accounts: ["research"], qos: ["debug", "normal"], reservations: [],
      warnings: ["Slurm reservations are unavailable to the configured SSH user."],
    });
    expect(remote.commands[0]?.args).toContain("user=alice");
  });

  it("reports configured runtime availability without policy", async () => {
    const remote = new MockExecutor([
      ok("/usr/bin/apptainer\n"), ok(),
      { stdout: "", stderr: "", exitCode: 1 },
      ok("/usr/bin/modulecmd\n"), { stdout: "", stderr: "", exitCode: 1 },
    ]);
    const client = new DiscoveryClient(
      remote, "alice", "/usr/bin/apptainer", "/usr/bin/srun", "/usr/bin/modulecmd",
    );
    await expect(client.runtimes()).resolves.toEqual({
      apptainer: {
        configured_path: "/usr/bin/apptainer", resolved_path: "/usr/bin/apptainer",
        available: true, executable: true,
      },
      srun: { configured_path: "/usr/bin/srun", available: false, executable: false },
      modulecmd: {
        configured_path: "/usr/bin/modulecmd", resolved_path: "/usr/bin/modulecmd",
        available: true, executable: false,
      },
    });
  });
});
