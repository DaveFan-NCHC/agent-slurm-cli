import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SshTestCluster } from "./support/ssh-test-cluster.js";

describe("Slurm query commands over SSH", () => {
  let cluster: SshTestCluster;

  beforeAll(async () => { cluster = await SshTestCluster.start(); });
  afterAll(() => cluster?.stop());

  it("lists node resources through sinfo", () => {
    const result = cluster.run(["nodes", "--partition", "test", "--state", "idle"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      query: { partition: "test", state: "IDLE" },
      nodes: [{
        node_name: "node01",
        partition: "test",
        state: "idle",
        cpus: { idle: 8, total: 8 },
        memory: { total_mib: 64000, allocated_mib: 0, free_mib: 60000 },
      }],
    });
    expect(cluster.calls().some((call) => call.startsWith("sinfo\t--noheader\t--Node"))).toBe(true);
  });

  it("queries bounded accounting history", () => {
    const result = cluster.run(["history", "--days", "1", "--state", "completed", "--limit", "5"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      query: { days: 1, states: ["COMPLETED"], limit: 5 },
      jobs: [{ job_id: "12345", state: "COMPLETED", allocated_cpus: 1, allocated_nodes: 1 }],
    });
    expect(cluster.calls().some((call) => call.includes("--starttime=now-1days"))).toBe(true);
  });

  it("reports only the configured user's fair-share entry", () => {
    const result = cluster.run(["fairshare"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      fairshare: [{ account: "research", user: cluster.user, fair_share: "1.0" }],
    });
    expect(cluster.calls().some((call) => call.startsWith("sshare\t"))).toBe(true);
  });

  it("combines queue and control data for diagnosis", () => {
    const result = cluster.run(["diagnose", "12345"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      job_id: "12345",
      job: { job_id: "12345", state: "RUNNING" },
      requested_resources: { nodes: 1, cpus: 1 },
      priority: { available: false },
      findings: [{ code: "JOB_RUNNING" }],
    });
    expect(cluster.calls()).toEqual(expect.arrayContaining([
      expect.stringContaining("squeue\t"),
      "scontrol\t--oneliner\tshow\tjob\t12345",
    ]));
  });

  it("combines accounting and live step usage", () => {
    const result = cluster.run(["usage", "12345"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      usage: {
        job_id: "12345",
        state: "RUNNING",
        elapsed_seconds: 60,
        live_available: true,
        live_steps: [{ step_id: "12345.batch", max_rss: "1M" }],
      },
    });
    expect(cluster.calls().some((call) => call.startsWith("sstat\t"))).toBe(true);
  });
});
