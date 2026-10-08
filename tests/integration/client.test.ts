import { describe, expect, it } from "vitest";
import { SlurmClient } from "../../src/slurm/client.js";
import type { Policy } from "../../src/policy/types.js";
import type { RemoteExecutor, RemoteResult, SafeCommand } from "../../src/transport/types.js";

const policy: Policy = {
  allowedPartitions: ["slurm-test"], maxNodes: 2, maxNtasks: 16, maxNtasksPerNode: 8, maxCpusPerTask: 8,
  maxMemoryGb: 64, maxGpus: 4, maxGpusPerNode: 4, maxGpusPerTask: 2, allowExclusive: true,
  maxTimeMinutes: 240, maxWaitSeconds: 3600,
  maxHistoryDays: 30, maxHistoryJobs: 200, maxListJobs: 200,
  maxArrayTasks: 1000, maxArrayConcurrency: 32, maxDependencyJobs: 16,
  allowedDependencyTypes: ["after", "afterany", "aftercorr", "afternotok", "afterok", "singleton"],
  maxLogLines: 1000, maxLogBytes: 1024,
  maxArtifactBytes: 4096, maxArtifactFiles: 100, allowedSignals: ["TERM", "USR1"],
  allowedApptainerImages: { pytorch: "/opt/apptainer/pytorch.sif" },
  allowedVirtualenvs: { "project-a": "/opt/venvs/project-a" },
  allowedGres: { a100x1: "gpu:a100:1" },
  allowedAccounts: { research: "proj123" }, allowedQos: { normal: "normal" },
  allowedConstraints: { modern: "[zen3|zen4]" }, allowedNodelists: { "gpu-a": "gpu[01-02]" },
  allowedExcludeNodelists: { maintenance: "gpu[03,07-09]" },
  allowedReservations: { workshop: "ws2026" },
  maxScriptBytes: 65536, maxScriptArgs: 32, maxScriptArgLength: 1024,
  requireApptainerForGeneratedScripts: false,
};

class MockExecutor implements RemoteExecutor {
  readonly commands: SafeCommand[] = [];
  readonly downloads: Array<{ remotePath: string; localPath: string; maxBytes: number }> = [];
  readonly uploads: Array<{ remotePath: string; content: Buffer; maxBytes: number }> = [];
  constructor(private readonly results: RemoteResult[]) {}
  async run(command: SafeCommand): Promise<RemoteResult> {
    this.commands.push(command);
    const result = this.results.shift();
    if (!result) throw new Error("Missing mock result");
    return result;
  }
  async downloadArtifact({ remotePath, localPath, maxBytes }: { remotePath: string; localPath: string; maxBytes: number }): Promise<{ bytes: number }> {
    this.downloads.push({ remotePath, localPath, maxBytes });
    return { bytes: 5 };
  }
  async uploadSubmission({ remotePath, content, maxBytes }: { remotePath: string; content: Buffer; maxBytes: number }): Promise<{ bytes: number }> {
    this.uploads.push({ remotePath, content, maxBytes });
    return { bytes: content.length };
  }
  async close(): Promise<void> {}
}

const ok = (stdout = ""): RemoteResult => ({ stdout, stderr: "", exitCode: 0 });
const prepared = { content: Buffer.from("#!/bin/sh\necho ok\n"), relativePath: "jobs/test.sh", sha256: "abc123" };

describe("Slurm client security boundaries", () => {
  it("constructs submit from validated fields and fixed log paths", async () => {
    const remote = new MockExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12345;cluster\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 4, cpusPerTask: 2,
      memory: "8G", time: "01:00:00", jobName: "test", memoryGb: 8, timeMinutes: 60,
      scriptArgs: ["--epochs", "20"],
    }, prepared)).resolves.toBe("12345");
    const submit = remote.commands.at(-1)!;
    expect(submit.executable).toBe("sbatch");
    expect(submit.args).toContain("--output=/work/.slurm-agent/logs/%j.out");
    expect(submit.args.find((argument) => argument.startsWith("--export="))).not.toContain("ALL");
    expect(submit.args.slice(-2)).toEqual(["--epochs", "20"]);
    expect(remote.uploads).toHaveLength(2);
    expect(remote.uploads[0]?.remotePath).toBe("/work/.slurm-agent/submissions/staged/payload");
  });

  it("exposes bounded sanitized sbatch diagnostics when submission is rejected", async () => {
    const remote = new MockExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"),
      {
        stdout: "",
        stderr: "\u001b[31msbatch: error:\u001b[0m Invalid account\u0000\n" + "界".repeat(2000),
        exitCode: 1,
      },
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    const failure = await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10, scriptArgs: [],
    }, prepared).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "SLURM_SUBMIT_FAILED",
      details: {
        remote_exit_code: 1,
        slurm_message_truncated: true,
      },
    });
    expect(failure.details.slurm_message.startsWith("sbatch: error: Invalid account\n")).toBe(true);
    expect(failure.details.slurm_message).not.toContain("\u001b");
    expect(Buffer.byteLength(failure.details.slurm_message)).toBeLessThanOrEqual(4096);
  });

  it("passes policy-resolved scheduler aliases to sbatch", async () => {
    const remote = new MockExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10, scriptArgs: [],
      account: "research", accountValue: "proj123", qos: "normal", qosValue: "normal",
      constraint: "modern", constraintValue: "[zen3|zen4]",
      nodelist: "gpu-a", nodelistValue: "gpu[01-02]",
      exclude: "maintenance", excludeValue: "gpu[03,07-09]",
      reservation: "workshop", reservationValue: "ws2026",
    }, prepared);
    const args = remote.commands.at(-1)?.args ?? [];
    expect(args).toContain("--account=proj123");
    expect(args).toContain("--qos=normal");
    expect(args).toContain("--constraint=[zen3|zen4]");
    expect(args).toContain("--nodelist=gpu[01-02]");
    expect(args).toContain("--exclude=gpu[03,07-09]");
    expect(args).toContain("--reservation=ws2026");
    expect(args).not.toContain("--account=research");
    expect(args).not.toContain("--constraint=modern");
    expect(args).not.toContain("--nodelist=gpu-a");
    expect(args).not.toContain("--exclude=maintenance");
  });

  it("passes MPI topology, per-CPU memory, per-node GPUs, and exclusivity to sbatch", async () => {
    const remote = new MockExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 2, ntasks: 4, ntasksPerNode: 2,
      cpusPerTask: 2, memoryPerCpu: "2G", time: "00:10:00", memoryGb: 16, timeMinutes: 10,
      gpusPerNode: 2, scriptArgs: [],
    }, prepared);
    const args = remote.commands.at(-1)?.args ?? [];
    expect(args).toContain("--ntasks-per-node=2");
    expect(args).toContain("--mem-per-cpu=2G");
    expect(args.some((argument) => argument.startsWith("--mem="))).toBe(false);
    expect(args).toContain("--gpus-per-node=2");

    const exclusiveRemote = new MockExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12346\n"),
    ]);
    const exclusiveClient = new SlurmClient(exclusiveRemote, "alice", "/work", policy);
    await exclusiveClient.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "8G", time: "00:10:00", memoryGb: 8, timeMinutes: 10, exclusive: true, scriptArgs: [],
    }, prepared);
    expect(exclusiveRemote.commands.at(-1)?.args).toContain("--exclusive");
  });

  it("submits bounded arrays with owned dependencies and array-safe output paths", async () => {
    const remote = new MockExecutor([
      ok("77|alice|prepare|slurm-test|RUNNING|00:01\n"),
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      array: "0-9%2", arrayTaskCount: 10, arrayConcurrency: 2,
      dependency: "afterok:77", dependencyJobIds: ["77"], scriptArgs: [],
    }, prepared)).resolves.toBe("12345");
    const submit = remote.commands.at(-1)!;
    expect(submit.args).toContain("--array=0-9%2");
    expect(submit.args).toContain("--dependency=afterok:77");
    expect(submit.args).toContain("--output=/work/.slurm-agent/logs/%A_%a.out");
    expect(submit.args).toContain("--error=/work/.slurm-agent/logs/%A_%a.err");
    expect(remote.commands[0]).toMatchObject({ executable: "squeue" });
  });

  it("rejects a dependency on another user's job before submission", async () => {
    const remote = new MockExecutor([ok("77|bob|prepare|slurm-test|RUNNING|00:01\n")]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      dependency: "afterok:77", dependencyJobIds: ["77"], scriptArgs: [],
    }, prepared)).rejects.toMatchObject({ code: "JOB_NOT_OWNED_BY_USER" });
    expect(remote.commands.some((command) => command.executable === "sbatch")).toBe(false);
  });

  it("queries only policy-allowed partitions for cluster information", async () => {
    const remote = new MockExecutor([
      ok("slurm-test*|up|04:00:00|2|idle|0/32/0/32|gpu:a100:4\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.clusterInfo()).resolves.toEqual([{
      partition: "slurm-test", availability: "up", time_limit: "04:00:00", nodes: 2,
      node_state: "idle", cpus: { allocated: 0, idle: 32, other: 0, total: 32 },
      gres: ["gpu:a100:4"],
    }]);
    expect(remote.commands[0]).toEqual({
      executable: "sinfo",
      args: ["--noheader", "--partition=slurm-test", "--format=%P|%a|%l|%D|%t|%C|%G"],
    });
  });

  it("lists nodes only from policy-allowed partitions", async () => {
    const remote = new MockExecutor([
      ok("gpu01|slurm-test*|up|idle|0/112/0/112|gpu:h200:8\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.nodes()).resolves.toEqual([{
      node_name: "gpu01", partition: "slurm-test", availability: "up", state: "idle",
      cpus: { allocated: 0, idle: 112, other: 0, total: 112 }, gres: ["gpu:h200:8"],
      memory: { total_mib: 0 }, gres_configured: ["gpu:h200:8"], gres_used: [],
      features: [], active_features: [],
    }]);
    expect(remote.commands[0]).toEqual({
      executable: "sinfo",
      args: [
        "--noheader", "--Node", "--partition=slurm-test",
        "--Format=NodeList:.256|,Partition:.128|,Available:.16|,StateLong:.64|,CPUsState:.64|,Memory:.32|,AllocMem:.32|,FreeMem:.32|,Gres:.1024|,GresUsed:.1024|,Features:.1024|,features_act:.1024|,Reason:.256|,TimeStamp:.64|,Disk:.32",
      ],
      maxOutputBytes: 1048576,
    });
  });

  it("rejects node rows outside policy-allowed partitions", async () => {
    const remote = new MockExecutor([ok("gpu01|admin|up|idle|0/112/0/112|gpu:h200:8\n")]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.nodes()).rejects.toMatchObject({ code: "SLURM_QUERY_FAILED" });
  });

  it("applies bounded node state and feature filters", async () => {
    const matching = "gpu01|slurm-test*|up|idle|0/64/0/64|515000|0|500000|gpu:a100:4|gpu:a100:0(IDX:N/A)|zen4,a100|zen4,a100|None|Unknown|102400";
    const other = "gpu02|slurm-test*|up|idle|0/64/0/64|515000|0|500000|gpu:a100:4|gpu:a100:0(IDX:N/A)|zen3,a100|zen3,a100|None|Unknown|102400";
    const remote = new MockExecutor([ok(`${matching}\n${other}\n`)]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.nodes({ partition: "slurm-test", state: "idle", feature: "zen4" }))
      .resolves.toEqual([expect.objectContaining({ node_name: "gpu01", features: ["zen4", "a100"] })]);
    expect(remote.commands[0]?.args).toEqual(expect.arrayContaining([
      "--partition=slurm-test", "--states=idle",
    ]));
  });

  it("returns detailed active-job scheduling diagnostics", async () => {
    const row = [
      "44", "alice", "train", "slurm-test", "PENDING", "0:00", "Priority", "4512",
      "2026-09-01T10:00:00", "2026-08-31T09:00:00", "01:00:00", "01:00:00", "",
      "2", "16", "proj123", "normal", "ws2026",
    ].join("|");
    const remote = new MockExecutor([ok(`${row}\n`)]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.getOwnedJob("44")).resolves.toMatchObject({
      job_id: "44", reason: "Priority", priority: 4512,
      start_time: "2026-09-01T10:00:00", time_left: "01:00:00",
      nodes: 2, cpus: 16, account: "proj123", qos: "normal", reservation: "ws2026",
    });
    expect(remote.commands[0]?.args.at(-1)).toContain("%r|%Q|%S|%V|%l|%L|%N|%D|%C|%a|%q|%v");
  });

  it("applies bounded queue filters and local sorting", async () => {
    const older = [
      "10", "alice", "train", "slurm-test", "PENDING", "0:00", "Priority", "100", "Unknown",
      "2026-10-08T09:00:00", "01:00:00", "01:00:00", "", "1", "4", "proj123", "normal", "",
    ].join("|");
    const newer = [
      "11", "alice", "train", "slurm-test", "PENDING", "0:00", "Resources", "200", "Unknown",
      "2026-10-08T10:00:00", "01:00:00", "01:00:00", "", "1", "4", "proj123", "normal", "",
    ].join("|");
    const remote = new MockExecutor([ok(`${older}\n${newer}\n`)]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.list({
      states: ["PENDING"], partition: "slurm-test", name: "train", account: "proj123",
      limit: 1, sort: "submit_time_desc", array_view: "summary",
    })).resolves.toEqual([expect.objectContaining({ job_id: "11" })]);
    expect(remote.commands[0]?.args).toEqual(expect.arrayContaining([
      "--states=PENDING", "--partition=slurm-test", "--name=train", "--account=proj123",
    ]));
    expect(remote.commands[0]?.args).not.toContain("--array");
  });

  it("diagnoses a pending owned job with scheduling and priority factors", async () => {
    const active = [
      "44", "alice", "train", "slurm-test", "PENDING", "0:00", "Priority", "48321", "2026-10-08T18:30:00",
      "2026-10-08T09:00:00", "01:00:00", "01:00:00", "", "1", "8", "proj123", "normal", "",
    ].join("|");
    const details = "JobId=44 JobName=train UserId=alice(1000) JobState=PENDING Reason=Priority Dependency=(null) EligibleTime=2026-10-08T09:00:00 NumNodes=1 NumCPUs=8 ReqTRES=cpu=8,mem=32G,node=1,gres/gpu=1";
    const remote = new MockExecutor([ok(`${active}\n`), ok(details), ok("44|48321|1200|0|35100|21|12000|0|0|-5|5\n")]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.diagnose("44")).resolves.toMatchObject({
      job_id: "44", job: {
        state: "PENDING", eligible_time: "2026-10-08T09:00:00",
        expected_start_time: "2026-10-08T18:30:00",
      },
      requested_resources: { nodes: 1, cpus: 8, memory: "32G" },
      priority: { available: true, total: 48321, fairshare: 35100 },
      findings: [{ code: "WAITING_FOR_PRIORITY" }],
    });
    expect(remote.commands[1]).toEqual({
      executable: "scontrol", args: ["--oneliner", "show", "job", "44"], maxOutputBytes: 262144,
    });
    expect(remote.commands[2]?.executable).toBe("sprio");
  });

  it("degrades diagnose when sprio is unavailable", async () => {
    const active = "44|alice|train|slurm-test|PENDING|0:00|Resources|100|Unknown|2026-10-08T09:00:00|01:00:00|01:00:00||1|8|proj123|normal|\n";
    const remote = new MockExecutor([
      ok(active), ok("JobId=44 JobState=PENDING NumNodes=1 NumCPUs=8 ReqTRES=cpu=8,mem=8G,node=1"),
      { stdout: "", stderr: "priority/basic", exitCode: 1 },
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.diagnose("44")).resolves.toMatchObject({
      priority: { available: false }, findings: [{ code: "WAITING_FOR_RESOURCES" }],
    });
  });

  it("diagnoses a completed accounting job when live details are no longer available", async () => {
    const completed = [
      "44", "alice", "train", "slurm-test", "COMPLETED", "00:10:00", "0:0", "None", "4512",
      "2026-10-08T09:05:00", "2026-10-08T09:00:00", "01:00:00", "node01", "1", "8",
      "proj123", "normal", "",
    ].join("|");
    const remote = new MockExecutor([
      ok(), ok(`${completed}\n`), { stdout: "", stderr: "Invalid job id specified", exitCode: 1 },
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.diagnose("44")).resolves.toMatchObject({
      job: { state: "COMPLETED" }, priority: { available: false },
      requested_resources: { nodes: 1, cpus: 8 }, findings: [{ code: "JOB_COMPLETED" }],
    });
    expect(remote.commands.some((command) => command.executable === "sprio")).toBe(false);
  });

  it("rejects diagnose for another user's job before scheduling-detail queries", async () => {
    const foreign = "44|mallory|train|slurm-test|PENDING|0:00|Priority|100|Unknown|2026-10-08T09:00:00|01:00:00|01:00:00||1|8|proj123|normal|\n";
    const remote = new MockExecutor([ok(foreign)]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.diagnose("44")).rejects.toMatchObject({ code: "JOB_NOT_OWNED_BY_USER" });
    expect(remote.commands.some((command) => ["scontrol", "sprio"].includes(command.executable))).toBe(false);
  });

  it("fails diagnose closed when required job details are truncated", async () => {
    const active = "44|alice|train|slurm-test|PENDING|0:00|Priority|100|Unknown|2026-10-08T09:00:00|01:00:00|01:00:00||1|8|proj123|normal|\n";
    const remote = new MockExecutor([ok(active), { ...ok("JobId=44"), stdoutTruncated: true }]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.diagnose("44")).rejects.toMatchObject({ code: "SLURM_QUERY_FAILED" });
    expect(remote.commands.some((command) => command.executable === "sprio")).toBe(false);
  });

  it("fails diagnose closed on malformed successful sprio output", async () => {
    const active = "44|alice|train|slurm-test|PENDING|0:00|Priority|100|Unknown|2026-10-08T09:00:00|01:00:00|01:00:00||1|8|proj123|normal|\n";
    const remote = new MockExecutor([
      ok(active), ok("JobId=44 JobState=PENDING NumNodes=1 NumCPUs=8"), ok("44|not-a-priority\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.diagnose("44")).rejects.toMatchObject({ code: "SLURM_QUERY_FAILED" });
  });

  it("lists detailed scheduling diagnostics for the configured user", async () => {
    const row = [
      "44", "alice", "train", "slurm-test", "RUNNING", "00:10", "None", "4512",
      "2026-08-31T09:05:00", "2026-08-31T09:00:00", "01:00:00", "00:50:00", "node01",
      "1", "8", "proj123", "normal", "",
    ].join("|");
    const remote = new MockExecutor([ok(`${row}\n`)]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.list()).resolves.toEqual([
      expect.objectContaining({ job_id: "44", node_list: "node01", time_left: "00:50:00", account: "proj123" }),
    ]);
    expect(remote.commands[0]?.args).toContain("--user");
    expect(remote.commands[0]?.args.at(-1)).toContain("%r|%Q|%S|%V|%l|%L|%N|%D|%C|%a|%q|%v");
  });

  it("rejects queue rows returned for another user", async () => {
    const row = "44|mallory|train|slurm-test|RUNNING|00:10|None|4512|2026-08-31T09:05:00|2026-08-31T09:00:00|01:00:00|00:50:00|node01|1|8|proj123|normal|\n";
    const client = new SlurmClient(new MockExecutor([ok(row)]), "alice", "/work", policy);
    await expect(client.list()).rejects.toMatchObject({ code: "JOB_NOT_OWNED_BY_USER" });
  });

  it("returns retained detailed accounting status for a completed job", async () => {
    const row = [
      "44", "alice", "train", "slurm-test", "COMPLETED", "00:10:00", "0:0", "None", "4512",
      "2026-08-31T09:05:00", "2026-08-31T09:00:00", "01:00:00", "node01", "1", "8",
      "proj123", "normal", "",
    ].join("|");
    const remote = new MockExecutor([ok(), ok(`${row}\n`)]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.getOwnedJob("44")).resolves.toMatchObject({
      job_id: "44", state: "COMPLETED", exit_code: "0:0", start_time: "2026-08-31T09:05:00",
      node_list: "node01", nodes: 1, cpus: 8,
    });
    expect(remote.commands.at(-1)?.args.at(-1)).toContain("Reason,Priority,Start,Submit,Timelimit");
  });

  it.each([
    ["hold", "hold"],
    ["release", "release"],
    ["requeue", "requeue"],
  ] as const)("verifies ownership before %s", async (method, operation) => {
    const remote = new MockExecutor([ok("44|alice|train|slurm-test|PENDING|0:00\n"), ok()]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await client[method]("44");
    expect(remote.commands.at(-1)).toEqual({ executable: "scontrol", args: [operation, "44"] });
  });

  it("updates only approved fields after target and dependency ownership checks", async () => {
    const remote = new MockExecutor([
      ok("44|alice|train|slurm-test|PENDING|0:00\n"),
      ok("77|alice|prepare|slurm-test|RUNNING|00:01\n"),
      ok(),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await client.update("44", {
      time: "02:00:00", timeMinutes: 120, dependency: "afterok:77",
      dependencyJobIds: ["77"], arrayConcurrency: 8,
    });
    expect(remote.commands.at(-1)).toEqual({
      executable: "scontrol",
      args: ["update", "JobId=44", "TimeLimit=02:00:00", "Dependency=afterok:77", "ArrayTaskThrottle=8"],
    });
  });

  it("signals only an owned job with the selected Slurm scope", async () => {
    const remote = new MockExecutor([ok("44|alice|train|slurm-test|RUNNING|0:01\n"), ok()]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await client.signal("44", "USR1", "full");
    expect(remote.commands.at(-1)).toEqual({
      executable: "scancel", args: ["--signal=USR1", "--full", "44"],
    });
  });

  it("queries fair-share data only for the configured user", async () => {
    const row = "proj123|alice|100|0.5|200|0.25|0.75|1.5|cpu=20|cpu=3\n";
    const remote = new MockExecutor([ok(row)]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.fairshare()).resolves.toEqual([
      expect.objectContaining({ account: "proj123", user: "alice", fair_share: "0.75" }),
    ]);
    expect(remote.commands[0]).toMatchObject({ executable: "sshare", maxOutputBytes: 1048576 });
    expect(remote.commands[0]?.args).toContain("--users=alice");
  });

  it("rejects fair-share rows for another user", async () => {
    const row = "proj123|mallory|100|0.5|200|0.25|0.75|1.5|cpu=20|cpu=3\n";
    const client = new SlurmClient(new MockExecutor([ok(row)]), "alice", "/work", policy);
    await expect(client.fairshare()).rejects.toMatchObject({ code: "SLURM_QUERY_FAILED" });
  });

  it("rejects control of another user's job", async () => {
    const remote = new MockExecutor([ok("44|mallory|train|slurm-test|PENDING|0:00\n")]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.hold("44")).rejects.toMatchObject({ code: "JOB_NOT_OWNED_BY_USER" });
    expect(remote.commands.some((command) => command.executable === "scontrol")).toBe(false);
  });

  it("fails closed if sinfo returns a partition outside policy", async () => {
    const remote = new MockExecutor([
      ok("admin|up|04:00:00|1|idle|0/16/0/16|(null)\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.clusterInfo()).rejects.toMatchObject({ code: "SLURM_QUERY_FAILED" });
  });

  it("exposes sanitized diagnostics for non-submit Slurm command failures", async () => {
    const client = new SlurmClient(new MockExecutor([{
      stdout: "",
      stderr: "\u001b[31msinfo: error:\u001b[0m controller unavailable\u0000\n",
      exitCode: 1,
    }]), "alice", "/work", policy);

    await expect(client.clusterInfo()).rejects.toMatchObject({
      code: "SLURM_QUERY_FAILED",
      details: {
        remote_exit_code: 1,
        slurm_message: "sinfo: error: controller unavailable",
      },
    });
  });

  it("lists bounded history for only the configured user", async () => {
    const first = [
      "43", "alice", "old", "slurm-test", "FAILED", "00:01:00",
      "2026-08-29T10:00:00", "2026-08-29T10:01:00", "1:0", "1", "1", "1Gn", "cpu=1,mem=1G,node=1",
    ].join("|");
    const second = [
      "44", "alice", "new", "slurm-test", "COMPLETED", "00:02:00",
      "2026-08-30T10:00:00", "2026-08-30T10:02:00", "0:0", "2", "1", "2Gn", "cpu=2,mem=2G,node=1",
    ].join("|");
    const remote = new MockExecutor([ok(`${first}\n${second}\n`)]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.history(7, "COMPLETED", 1)).resolves.toEqual([
      expect.objectContaining({ job_id: "44", state: "COMPLETED" }),
    ]);
    expect(remote.commands[0]).toMatchObject({ executable: "sacct", maxOutputBytes: 1048576 });
    expect(remote.commands[0]?.args).toContain("--user=alice");
    expect(remote.commands[0]?.args).toContain("--starttime=now-7days");
    expect(remote.commands[0]?.args).toContain("--state=COMPLETED");
  });

  it("applies explicit bounded history filters", async () => {
    const row = [
      "44", "alice", "train", "slurm-test", "FAILED", "00:01:00",
      "2026-10-07T10:00:00", "2026-10-07T10:01:00", "1:0", "1", "1", "1Gn", "cpu=1,mem=1G,node=1",
    ].join("|");
    const remote = new MockExecutor([ok(`${row}\n`)]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.history({
      since: "2026-10-01T00:00:00", until: "2026-10-08T00:00:00", states: ["FAILED"],
      partition: "slurm-test", name: "train", account: "proj123", limit: 10,
      sort: "end_time_desc", array_view: "expanded",
    })).resolves.toEqual([expect.objectContaining({ job_id: "44" })]);
    expect(remote.commands[0]?.args).toEqual(expect.arrayContaining([
      "--array", "--starttime=2026-10-01T00:00:00", "--endtime=2026-10-08T00:00:00",
      "--state=FAILED", "--partition=slurm-test", "--name=train", "--accounts=proj123",
    ]));
  });

  it("rejects history rows returned for another user", async () => {
    const row = [
      "44", "mallory", "job", "slurm-test", "COMPLETED", "00:01:00",
      "2026-08-30T10:00:00", "2026-08-30T10:01:00", "0:0", "1", "1", "1Gn", "cpu=1,mem=1G,node=1",
    ].join("|");
    const client = new SlurmClient(new MockExecutor([ok(`${row}\n`)]), "alice", "/work", policy);
    await expect(client.history(7, undefined, 50)).rejects.toMatchObject({ code: "SLURM_QUERY_FAILED" });
  });

  it("reports completed job usage and derived efficiency", async () => {
    const allocation = [
      "44", "alice", "train", "slurm-test", "COMPLETED", "00:10:00", "600", "4", "1", "2Gn",
      "billing=4,cpu=4,mem=2G,node=1", "billing=4,cpu=4,mem=2G,node=1",
      "00:20:00", "", "", "", "", "0:0",
    ].join("|");
    const batch = [
      "44.batch", "alice", "batch", "slurm-test", "COMPLETED", "00:10:00", "600", "4", "1", "", "",
      "cpu=4,mem=2G", "00:20:00", "1G", "2G", "100M", "50M", "0:0",
    ].join("|");
    const remote = new MockExecutor([
      ok(""), ok("44|alice|train|slurm-test|COMPLETED|00:10:00|0:0\n"),
      ok(`${allocation}\n${batch}\n`),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.usage("44")).resolves.toMatchObject({
      job_id: "44", cpu_efficiency_percent: 50, memory_efficiency_percent: 50,
      live_available: false, steps: [{ step_id: "44.batch" }],
    });
    expect(remote.commands.at(-1)?.executable).toBe("sacct");
  });

  it("adds live sstat metrics for a running job", async () => {
    const allocation = [
      "44", "alice", "train", "slurm-test", "RUNNING", "00:05:00", "300", "4", "1", "2Gn",
      "billing=4,cpu=4,mem=2G,node=1", "billing=4,cpu=4,mem=2G,node=1",
      "00:05:00", "", "", "", "", "0:0",
    ].join("|");
    const remote = new MockExecutor([
      ok("44|alice|train|slurm-test|RUNNING|00:05:00\n"), ok(`${allocation}\n`),
      ok("44.batch|00:01:00|512M|1G|10M|5M|cpu=4,mem=2G\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.usage("44")).resolves.toMatchObject({
      state: "RUNNING", live_available: true,
      live_steps: [{ step_id: "44.batch", max_rss: "512M" }],
    });
    expect(remote.commands.at(-1)?.executable).toBe("sstat");
  });

  it("keeps accounting usage when live metrics have no steps", async () => {
    const allocation = [
      "44", "alice", "train", "slurm-test", "RUNNING", "00:05:00", "300", "4", "1", "2Gn",
      "billing=4,cpu=4,mem=2G,node=1", "billing=4,cpu=4,mem=2G,node=1",
      "00:05:00", "", "", "", "", "0:0",
    ].join("|");
    const remote = new MockExecutor([
      ok("44|alice|train|slurm-test|RUNNING|00:05:00\n"), ok(`${allocation}\n`), ok(),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.usage("44")).resolves.toMatchObject({
      state: "RUNNING", live_available: false, live_steps: [],
    });
  });

  it("passes validated GPU and GRES requests to sbatch", async () => {
    const makeRemote = () => new MockExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const gpuRemote = makeRemote();
    const client = new SlurmClient(gpuRemote, "alice", "/work", policy);
    await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10, gpus: 2, scriptArgs: [],
    }, prepared);
    expect(gpuRemote.commands.at(-1)?.args).toContain("--gpus=2");

    const gresRemote = makeRemote();
    const gresClient = new SlurmClient(gresRemote, "alice", "/work", policy);
    await gresClient.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      gres: "a100x1", gresValue: "gpu:a100:1", scriptArgs: [],
    }, prepared);
    expect(gresRemote.commands.at(-1)?.args).toContain("--gres=gpu:a100:1");
    expect(gresRemote.commands.at(-1)?.args).not.toContain("--gres=a100x1");
  });

  it("waits until an owned job reaches a terminal state", async () => {
    const remote = new MockExecutor([
      ok("44|alice|job|p|RUNNING|00:01\n"),
      ok(""), ok(""),
      ok(""),
      ok("44|alice|job|p|COMPLETED|00:01|0:0\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.wait("44", 1, 0)).resolves.toMatchObject({
      terminal: true, timed_out: false, job: { job_id: "44", state: "COMPLETED" },
    });
  });

  it("returns the last observed state when wait times out", async () => {
    const remote = new MockExecutor([ok("44|alice|job|p|RUNNING|00:01\n")]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.wait("44", 0, 0)).resolves.toMatchObject({
      terminal: false, timed_out: true, job: { job_id: "44", state: "RUNNING" },
    });
  });

  it("exports a policy-resolved Apptainer image", async () => {
    const remote = new MockExecutor([
      ok("/work\n"), ok("/opt/apptainer/pytorch.sif\n"), ok(),
      ok("/usr/bin/apptainer\n"), ok(), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      apptainerImage: "pytorch", apptainerImagePath: "/opt/apptainer/pytorch.sif",
      scriptArgs: [],
    }, prepared);
    const exported = remote.commands.at(-1)?.args.find((argument) => argument.startsWith("--export="));
    expect(exported).toContain("SLURM_AGENT_APPTAINER_IMAGE=/opt/apptainer/pytorch.sif");
    expect(exported).toContain("SLURM_AGENT_APPTAINER_EXECUTABLE=/usr/bin/apptainer");
    expect(exported).not.toContain("ALL");
  });

  it("exports a policy-resolved virtual environment after validating bin/python", async () => {
    const remote = new MockExecutor([
      ok("/work\n"), ok("/opt/venvs/project-a\n"), ok(), ok(), ok(),
      ok("/work/.slurm-agent/logs\n"), ok("/work/.slurm-agent/artifacts\n"),
      ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      venv: "project-a", venvPath: "/opt/venvs/project-a",
      scriptArgs: [],
    }, prepared);
    expect(remote.commands).toContainEqual({ executable: "test", args: ["-x", "/opt/venvs/project-a/bin/python"] });
    expect(remote.commands.filter((command) => command.executable === "test").every((command) => !command.args.includes("--"))).toBe(true);
    expect(remote.commands.at(-1)?.args.find((argument) => argument.startsWith("--export=")))
      .toContain("SLURM_AGENT_VENV=/opt/venvs/project-a");
  });

  it("rejects a missing policy-resolved runtime before sbatch", async () => {
    const remote = new MockExecutor([ok("/work\n"), { ...ok(), exitCode: 1 }]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      apptainerImage: "pytorch", apptainerImagePath: "/opt/apptainer/pytorch.sif",
      scriptArgs: [],
    }, prepared)).rejects.toMatchObject({ code: "RUNTIME_NOT_FOUND" });
    expect(remote.commands.some((command) => command.executable === "sbatch")).toBe(false);
  });

  it("rejects a log-directory symlink that resolves outside workspace", async () => {
    const remote = new MockExecutor([
      ok("/work\n"), ok(), ok("/tmp/stolen-logs\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10, scriptArgs: [],
    }, prepared)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(remote.commands.some((command) => command.executable === "sbatch")).toBe(false);
  });

  it("rejects an artifact-directory symlink that resolves outside workspace", async () => {
    const remote = new MockExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"), ok("/tmp/artifacts\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10, scriptArgs: [],
    }, prepared)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(remote.commands.some((command) => command.executable === "sbatch")).toBe(false);
  });

  it("refuses to cancel another user's job", async () => {
    const remote = new MockExecutor([ok("44|bob|job|p|RUNNING|00:01\n")]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.cancel("44")).rejects.toMatchObject({ code: "JOB_NOT_OWNED_BY_USER" });
    expect(remote.commands.some((command) => command.executable === "scancel")).toBe(false);
  });

  it("cancels an owned array through its parent job ID", async () => {
    const remote = new MockExecutor([
      ok("44_0|alice|job|p|PENDING|00:00\n44_1|alice|job|p|RUNNING|00:01\n"), ok(),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.cancel("44")).resolves.toBeUndefined();
    expect(remote.commands.at(-1)).toEqual({ executable: "scancel", args: ["44"] });
  });

  it("requires an explicit array task ID for per-task operations", async () => {
    const remote = new MockExecutor([ok("44_0|alice|job|p|RUNNING|00:01\n")]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.getOwnedJob("44")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("reads only the fixed per-job log after ownership and containment checks", async () => {
    const remote = new MockExecutor([
      ok("44|alice|job|p|RUNNING|00:01\n"), ok("/work\n"), ok("/work/.slurm-agent/logs/44.out\n"),
      { ...ok("hello\n"), stdoutTruncated: false },
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.logs("44", "stdout", 20)).resolves.toMatchObject({ content: "hello\n" });
    expect(remote.commands.at(-1)).toMatchObject({ executable: "tail", maxOutputBytes: 1024 });
  });

  it("reads an individual array task log using its array task ID", async () => {
    const remote = new MockExecutor([
      ok("44_7|alice|job|p|RUNNING|00:01\n"), ok("/work\n"), ok("/work/.slurm-agent/logs/44_7.out\n"),
      { ...ok("task 7\n"), stdoutTruncated: false },
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.logs("44_7", "stdout", 20)).resolves.toMatchObject({
      job_id: "44_7", content: "task 7\n",
    });
  });

  it("downloads only from the owned job artifact directory", async () => {
    const remote = new MockExecutor([
      ok("44|alice|job|p|COMPLETED|00:01\n"), ok("/work\n"),
      ok("/work/.slurm-agent/artifacts/44\n"), ok("/work/.slurm-agent/artifacts/44/results/model.bin\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy, "/tmp/slurm-agent-test-artifacts");
    await expect(client.artifact("44", "results/model.bin")).resolves.toMatchObject({ bytes: 5 });
    expect(remote.downloads).toHaveLength(1);
    expect(remote.downloads[0]).toMatchObject({
      remotePath: "/work/.slurm-agent/artifacts/44/results/model.bin", maxBytes: 4096,
    });
    expect(remote.commands.some((command) => command.executable === "test")).toBe(false);
  });

  it("lists sorted regular-file artifacts after ownership and containment checks", async () => {
    const listing = ["z.bin", "2", "reports/result.txt", "12", ""].join("\0");
    const remote = new MockExecutor([
      ok("44|alice|job|p|COMPLETED|00:01\n"), ok("/work\n"),
      ok("/work/.slurm-agent/artifacts/44\n"), ok(listing),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.artifacts("44")).resolves.toEqual([
      { path: "reports/result.txt", bytes: 12 }, { path: "z.bin", bytes: 2 },
    ]);
    expect(remote.commands.at(-1)).toEqual({
      executable: "find",
      args: ["--", "/work/.slurm-agent/artifacts/44", "-xdev", "-type", "f", "-printf", String.raw`%P\0%s\0`],
      maxOutputBytes: 1048576,
    });
  });

  it("rejects artifact symlink escape before download", async () => {
    const remote = new MockExecutor([
      ok("44|alice|job|p|COMPLETED|00:01\n"), ok("/work\n"),
      ok("/work/.slurm-agent/artifacts/44\n"), ok("/etc/passwd\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy, "/tmp/slurm-agent-test-artifacts");
    await expect(client.artifact("44", "results/model.bin")).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(remote.downloads).toHaveLength(0);
  });

  it.each(["../secret", "/etc/passwd", "results/a;id", "results/a$(id)"])(
    "rejects artifact path %j before any remote operation", async (path) => {
      const remote = new MockExecutor([]);
      const client = new SlurmClient(remote, "alice", "/work", policy, "/tmp/slurm-agent-test-artifacts");
      await expect(client.artifact("44", path)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
      expect(remote.commands).toHaveLength(0);
      expect(remote.downloads).toHaveLength(0);
    },
  );
});
