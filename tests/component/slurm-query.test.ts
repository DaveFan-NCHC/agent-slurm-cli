import { describe, expect, it } from "vitest";
import { SlurmClient } from "../../src/slurm/client.js";
import {
  MockRemoteExecutor, ok, testPolicy,
} from "../support/slurm.js";

describe("Slurm query and diagnostics boundaries", () => {
  it("queries only policy-allowed partitions for cluster information", async () => {
    const remote = new MockRemoteExecutor([
      ok("slurm-test*|up|04:00:00|2|idle|0/32/0/32|gpu:a100:4\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
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
    const remote = new MockRemoteExecutor([
      ok("gpu01|slurm-test*|up|idle|0/112/0/112|gpu:h200:8\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
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
    const remote = new MockRemoteExecutor([ok("gpu01|admin|up|idle|0/112/0/112|gpu:h200:8\n")]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.nodes()).rejects.toMatchObject({ code: "SLURM_QUERY_FAILED" });
  });

  it("applies bounded node state and feature filters", async () => {
    const matching = "gpu01|slurm-test*|up|idle|0/64/0/64|515000|0|500000|gpu:a100:4|gpu:a100:0(IDX:N/A)|zen4,a100|zen4,a100|None|Unknown|102400";
    const other = "gpu02|slurm-test*|up|idle|0/64/0/64|515000|0|500000|gpu:a100:4|gpu:a100:0(IDX:N/A)|zen3,a100|zen3,a100|None|Unknown|102400";
    const remote = new MockRemoteExecutor([ok(`${matching}\n${other}\n`)]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
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
    const remote = new MockRemoteExecutor([ok(`${row}\n`)]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
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
    const remote = new MockRemoteExecutor([ok(`${older}\n${newer}\n`)]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
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
    const remote = new MockRemoteExecutor([ok(`${active}\n`), ok(details), ok("44|48321|1200|0|35100|21|12000|0|0|-5|5\n")]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
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
    const remote = new MockRemoteExecutor([
      ok(active), ok("JobId=44 JobState=PENDING NumNodes=1 NumCPUs=8 ReqTRES=cpu=8,mem=8G,node=1"),
      { stdout: "", stderr: "priority/basic", exitCode: 1 },
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
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
    const remote = new MockRemoteExecutor([
      ok(), ok(`${completed}\n`), { stdout: "", stderr: "Invalid job id specified", exitCode: 1 },
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.diagnose("44")).resolves.toMatchObject({
      job: { state: "COMPLETED" }, priority: { available: false },
      requested_resources: { nodes: 1, cpus: 8 }, findings: [{ code: "JOB_COMPLETED" }],
    });
    expect(remote.commands.some((command) => command.executable === "sprio")).toBe(false);
  });

  it("rejects diagnose for another user's job before scheduling-detail queries", async () => {
    const foreign = "44|mallory|train|slurm-test|PENDING|0:00|Priority|100|Unknown|2026-10-08T09:00:00|01:00:00|01:00:00||1|8|proj123|normal|\n";
    const remote = new MockRemoteExecutor([ok(foreign)]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.diagnose("44")).rejects.toMatchObject({ code: "JOB_NOT_OWNED_BY_USER" });
    expect(remote.commands.some((command) => ["scontrol", "sprio"].includes(command.executable))).toBe(false);
  });

  it("fails diagnose closed when required job details are truncated", async () => {
    const active = "44|alice|train|slurm-test|PENDING|0:00|Priority|100|Unknown|2026-10-08T09:00:00|01:00:00|01:00:00||1|8|proj123|normal|\n";
    const remote = new MockRemoteExecutor([ok(active), { ...ok("JobId=44"), stdoutTruncated: true }]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.diagnose("44")).rejects.toMatchObject({ code: "SLURM_QUERY_FAILED" });
    expect(remote.commands.some((command) => command.executable === "sprio")).toBe(false);
  });

  it("fails diagnose closed on malformed successful sprio output", async () => {
    const active = "44|alice|train|slurm-test|PENDING|0:00|Priority|100|Unknown|2026-10-08T09:00:00|01:00:00|01:00:00||1|8|proj123|normal|\n";
    const remote = new MockRemoteExecutor([
      ok(active), ok("JobId=44 JobState=PENDING NumNodes=1 NumCPUs=8"), ok("44|not-a-priority\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.diagnose("44")).rejects.toMatchObject({ code: "SLURM_QUERY_FAILED" });
  });

  it("lists detailed scheduling diagnostics for the configured user", async () => {
    const row = [
      "44", "alice", "train", "slurm-test", "RUNNING", "00:10", "None", "4512",
      "2026-08-31T09:05:00", "2026-08-31T09:00:00", "01:00:00", "00:50:00", "node01",
      "1", "8", "proj123", "normal", "",
    ].join("|");
    const remote = new MockRemoteExecutor([ok(`${row}\n`)]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.list()).resolves.toEqual([
      expect.objectContaining({ job_id: "44", node_list: "node01", time_left: "00:50:00", account: "proj123" }),
    ]);
    expect(remote.commands[0]?.args).toContain("--user");
    expect(remote.commands[0]?.args.at(-1)).toContain("%r|%Q|%S|%V|%l|%L|%N|%D|%C|%a|%q|%v");
  });

  it("rejects queue rows returned for another user", async () => {
    const row = "44|mallory|train|slurm-test|RUNNING|00:10|None|4512|2026-08-31T09:05:00|2026-08-31T09:00:00|01:00:00|00:50:00|node01|1|8|proj123|normal|\n";
    const client = new SlurmClient(new MockRemoteExecutor([ok(row)]), "alice", "/work", testPolicy);
    await expect(client.list()).rejects.toMatchObject({ code: "JOB_NOT_OWNED_BY_USER" });
  });

  it("returns retained detailed accounting status for a completed job", async () => {
    const row = [
      "44", "alice", "train", "slurm-test", "COMPLETED", "00:10:00", "0:0", "None", "4512",
      "2026-08-31T09:05:00", "2026-08-31T09:00:00", "01:00:00", "node01", "1", "8",
      "proj123", "normal", "",
    ].join("|");
    const remote = new MockRemoteExecutor([ok(), ok(`${row}\n`)]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
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
    const remote = new MockRemoteExecutor([ok("44|alice|train|slurm-test|PENDING|0:00\n"), ok()]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await client[method]("44");
    expect(remote.commands.at(-1)).toEqual({ executable: "scontrol", args: [operation, "44"] });
  });


});

