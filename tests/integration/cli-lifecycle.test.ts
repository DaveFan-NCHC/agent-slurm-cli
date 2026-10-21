import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SshTestCluster } from "./support/ssh-test-cluster.js";

describe("CLI lifecycle over SSH", () => {
  let cluster: SshTestCluster;

  beforeAll(async () => { cluster = await SshTestCluster.start(); });
  afterAll(() => cluster?.stop());

  it("queries the fake cluster through a real SSH command channel", () => {
    cluster.assertFixtureLayout();
    const result = cluster.run(["cluster-info"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      partitions: [{ partition: "test", availability: "up", nodes: 1 }],
    });
    expect(cluster.calls().some((call) => call.startsWith("sinfo\t"))).toBe(true);
  });

  it("submits files over SFTP and exercises status, logs, and cancel", () => {
    const submitted = cluster.run([
      "submit", "-p", "test", "-A", "research", "--qos", "normal",
      "jobs/integration.sh", "--literal", "argument",
    ]);
    expect(submitted.status, submitted.stderr).toBe(0);
    expect(submitted.json).toMatchObject({ ok: true, job_id: "12345" });

    const submissions = join(cluster.workspace, ".slurm-agent", "submissions");
    const submission = readdirSync(submissions)[0];
    expect(submission).toBeDefined();
    expect(readFileSync(join(submissions, submission!, "payload"), "utf8"))
      .toContain("echo integration");
    expect(existsSync(join(submissions, submission!, "runner"))).toBe(true);

    const status = cluster.run(["status", "12345"]);
    expect(status.status, status.stderr).toBe(0);
    expect(status.json).toMatchObject({ ok: true, job: { job_id: "12345", state: "RUNNING" } });

    const logs = cluster.run(["logs", "12345", "--tail", "10"]);
    expect(logs.status, logs.stderr).toBe(0);
    expect(logs.json).toMatchObject({
      ok: true, job_id: "12345", stream: "stdout", content: "integration job output\n",
    });

    const cancelled = cluster.run(["cancel", "12345"]);
    expect(cancelled.status, cancelled.stderr).toBe(0);
    expect(cancelled.json).toMatchObject({ ok: true, job_id: "12345", cancelled: true });
    expect(cluster.calls().some((call) => call === "scancel\t12345")).toBe(true);

    const audit = readFileSync(cluster.auditLog, "utf8").trim().split("\n").map(
      (line) => JSON.parse(line) as { action: string; result: string },
    );
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "submit", result: "success" }),
      expect.objectContaining({ action: "logs", result: "success" }),
      expect.objectContaining({ action: "cancel", result: "success" }),
    ]));
  });
});
