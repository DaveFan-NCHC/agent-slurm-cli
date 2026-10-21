import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SshTestCluster } from "./support/ssh-test-cluster.js";

describe("owned job control over SSH", () => {
  let cluster: SshTestCluster;

  beforeAll(async () => { cluster = await SshTestCluster.start(); });
  beforeEach(() => cluster.setMode("normal"));
  afterAll(() => cluster?.stop());

  it.each([
    ["hold", "held", "scontrol\thold\t12345"],
    ["release", "released", "scontrol\trelease\t12345"],
    ["requeue", "requeued", "scontrol\trequeue\t12345"],
  ])("executes %s only after checking job ownership", (command, resultField, expectedCall) => {
    const result = cluster.run([command, "12345"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({ ok: true, job_id: "12345", [resultField]: true });
    expect(cluster.calls()).toContain(expectedCall);
  });

  it("updates only normalized scheduler fields", () => {
    const result = cluster.run(["update", "12345", "--time", "00:30:00"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      ok: true, job_id: "12345", updated: { time: "00:30:00" },
    });
    expect(cluster.calls()).toContain("scontrol\tupdate\tJobId=12345\tTimeLimit=00:30:00");
  });

  it("signals the selected job scope", () => {
    const result = cluster.run(["signal", "12345", "--signal", "TERM", "--scope", "batch"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      ok: true, job_id: "12345", signalled: true, signal: "TERM", scope: "batch",
    });
    expect(cluster.calls()).toContain("scancel\t--signal=TERM\t--batch\t12345");
  });

  it("never sends a mutation for another user's job", () => {
    cluster.setMode("foreign");
    const before = cluster.calls().filter((call) => call === "scontrol\thold\t12345").length;
    const result = cluster.run(["hold", "12345"]);
    expect(result.status).toBe(7);
    expect(result.json).toMatchObject({
      ok: false,
      error: { code: "JOB_NOT_OWNED_BY_USER", category: "PERMISSION_DENIED" },
    });
    const after = cluster.calls().filter((call) => call === "scontrol\thold\t12345").length;
    expect(after).toBe(before);
  });
});
