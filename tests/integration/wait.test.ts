import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SshTestCluster } from "./support/ssh-test-cluster.js";

describe("job wait state transitions over SSH", () => {
  let cluster: SshTestCluster;

  beforeAll(async () => { cluster = await SshTestCluster.start(); });
  beforeEach(() => cluster.setMode("normal"));
  afterAll(() => cluster?.stop());

  it("observes a running job become terminal through accounting", () => {
    cluster.setMode("transition");
    const result = cluster.run(["wait", "12345", "--timeout", "3", "--poll-interval", "1"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      terminal: true,
      timed_out: false,
      job: { job_id: "12345", state: "COMPLETED" },
    });
    expect(cluster.calls().some((call) => call.startsWith("sacct\t"))).toBe(true);
  });

  it("returns the last owned state when the wait times out", () => {
    const result = cluster.run(["wait", "12345", "--timeout", "1", "--poll-interval", "1"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      terminal: false,
      timed_out: true,
      job: { job_id: "12345", state: "RUNNING" },
    });
  });
});
