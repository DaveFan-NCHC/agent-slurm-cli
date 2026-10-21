import { describe, expect, it } from "vitest";
import { SlurmClient } from "../../src/slurm/client.js";
import {
  MockRemoteExecutor, ok, testPolicy,
} from "../support/slurm.js";

describe("Slurm control and accounting boundaries", () => {
  it("updates only approved fields after target and dependency ownership checks", async () => {
    const remote = new MockRemoteExecutor([
      ok("44|alice|train|slurm-test|PENDING|0:00\n"),
      ok("77|alice|prepare|slurm-test|RUNNING|00:01\n"),
      ok(),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
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
    const remote = new MockRemoteExecutor([ok("44|alice|train|slurm-test|RUNNING|0:01\n"), ok()]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await client.signal("44", "USR1", "full");
    expect(remote.commands.at(-1)).toEqual({
      executable: "scancel", args: ["--signal=USR1", "--full", "44"],
    });
  });

  it("queries fair-share data only for the configured user", async () => {
    const row = "proj123|alice|100|0.5|200|0.25|0.75|1.5|cpu=20|cpu=3\n";
    const remote = new MockRemoteExecutor([ok(row)]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.fairshare()).resolves.toEqual([
      expect.objectContaining({ account: "proj123", user: "alice", fair_share: "0.75" }),
    ]);
    expect(remote.commands[0]).toMatchObject({ executable: "sshare", maxOutputBytes: 1048576 });
    expect(remote.commands[0]?.args).toContain("--users=alice");
  });

  it("rejects fair-share rows for another user", async () => {
    const row = "proj123|mallory|100|0.5|200|0.25|0.75|1.5|cpu=20|cpu=3\n";
    const client = new SlurmClient(new MockRemoteExecutor([ok(row)]), "alice", "/work", testPolicy);
    await expect(client.fairshare()).rejects.toMatchObject({ code: "SLURM_QUERY_FAILED" });
  });

  it("rejects control of another user's job", async () => {
    const remote = new MockRemoteExecutor([ok("44|mallory|train|slurm-test|PENDING|0:00\n")]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.hold("44")).rejects.toMatchObject({ code: "JOB_NOT_OWNED_BY_USER" });
    expect(remote.commands.some((command) => command.executable === "scontrol")).toBe(false);
  });

  it("fails closed if sinfo returns a partition outside testPolicy", async () => {
    const remote = new MockRemoteExecutor([
      ok("admin|up|04:00:00|1|idle|0/16/0/16|(null)\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.clusterInfo()).rejects.toMatchObject({ code: "SLURM_QUERY_FAILED" });
  });

  it("exposes sanitized diagnostics for non-submit Slurm command failures", async () => {
    const client = new SlurmClient(new MockRemoteExecutor([{
      stdout: "",
      stderr: "\u001b[31msinfo: error:\u001b[0m controller unavailable\u0000\n",
      exitCode: 1,
    }]), "alice", "/work", testPolicy);

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
    const remote = new MockRemoteExecutor([ok(`${first}\n${second}\n`)]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
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
    const remote = new MockRemoteExecutor([ok(`${row}\n`)]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
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
    const client = new SlurmClient(new MockRemoteExecutor([ok(`${row}\n`)]), "alice", "/work", testPolicy);
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
    const remote = new MockRemoteExecutor([
      ok(""), ok("44|alice|train|slurm-test|COMPLETED|00:10:00|0:0\n"),
      ok(`${allocation}\n${batch}\n`),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
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
    const remote = new MockRemoteExecutor([
      ok("44|alice|train|slurm-test|RUNNING|00:05:00\n"), ok(`${allocation}\n`),
      ok("44.batch|00:01:00|512M|1G|10M|5M|cpu=4,mem=2G\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
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
    const remote = new MockRemoteExecutor([
      ok("44|alice|train|slurm-test|RUNNING|00:05:00\n"), ok(`${allocation}\n`), ok(),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.usage("44")).resolves.toMatchObject({
      state: "RUNNING", live_available: false, live_steps: [],
    });
  });


});

