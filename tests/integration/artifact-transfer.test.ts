import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenSshCluster } from "./support/openssh-cluster.js";

describe("artifact transfer over OpenSSH SFTP", () => {
  let cluster: OpenSshCluster;

  beforeAll(async () => {
    cluster = await OpenSshCluster.start();
    const submitted = cluster.run(["submit", "-p", "test", "jobs/integration.sh"]);
    expect(submitted.status, submitted.stderr).toBe(0);
  });
  afterAll(() => cluster.stop());

  it("downloads and verifies a remote artifact through real SFTP", () => {
    const result = cluster.run(["artifact", "12345", "--path", "results/model.txt"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      artifact: { job_id: "12345", bytes: 21, overwritten: false },
    });
    expect(readFileSync(join(cluster.localArtifacts, "12345", "results", "model.txt"), "utf8"))
      .toBe("integration artifact\n");
    expect(cluster.calls().some((call) => call.startsWith("squeue\t"))).toBe(true);
  });

  it("rejects an artifact symlink that escapes the job directory", () => {
    const outside = join(cluster.root, "outside-secret.txt");
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, join(
      cluster.workspace, ".slurm-agent", "artifacts", "12345", "results", "escape.txt",
    ));
    const result = cluster.run(["artifact", "12345", "--path", "results/escape.txt"]);
    expect(result.status).toBe(3);
    expect(result.json).toMatchObject({
      ok: false,
      error: { category: "POLICY_DENIED", code: "PATH_NOT_ALLOWED" },
    });
  });
});
