import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SshTestCluster } from "./support/ssh-test-cluster.js";

describe("artifact transfer over SSH SFTP", () => {
  let cluster: SshTestCluster;

  beforeAll(async () => {
    cluster = await SshTestCluster.start();
    const submitted = cluster.run(["submit", "-p", "test", "jobs/integration.sh"]);
    expect(submitted.status, submitted.stderr).toBe(0);
  });
  afterAll(() => cluster?.stop());

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

  it("lists bounded regular-file artifacts", () => {
    const result = cluster.run(["artifacts", "12345"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      job_id: "12345",
      artifacts: [{ path: "results/model.txt", bytes: 21 }],
    });
  });

  it("downloads and verifies an artifact bundle with a prefix", () => {
    const result = cluster.run(["artifacts", "12345", "--download", "--prefix", "results"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      bundle: {
        job_id: "12345", format: "tar.gz", prefix: "results", overwritten: false,
      },
    });
    const bundle = result.json.bundle as { local_path: string; bytes: number; sha256: string };
    expect(bundle.bytes).toBeGreaterThan(0);
    expect(bundle.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(bundle.local_path)).toBe(true);
    const extracted = spawnSync("tar", ["-xOzf", bundle.local_path, "results/model.txt"], { encoding: "utf8" });
    expect(extracted.status, extracted.stderr).toBe(0);
    expect(extracted.stdout).toBe("integration artifact\n");
  });

  it("requires force before replacing an existing bundle", () => {
    const directory = join(cluster.workspace, ".slurm-agent", "artifacts", "12345", "force-case");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "result.txt"), "force integration\n");

    const initial = cluster.run(["artifacts", "12345", "--download", "--prefix", "force-case"]);
    expect(initial.status, initial.stderr).toBe(0);
    const rejected = cluster.run(["artifacts", "12345", "--download", "--prefix", "force-case"]);
    expect(rejected.status).toBe(1);
    expect(rejected.json).toMatchObject({ ok: false, error: { code: "ARTIFACT_ALREADY_EXISTS" } });

    const replaced = cluster.run([
      "artifacts", "12345", "--download", "--prefix", "force-case", "--force",
    ]);
    expect(replaced.status, replaced.stderr).toBe(0);
    expect(replaced.json).toMatchObject({
      ok: true,
      bundle: { job_id: "12345", prefix: "force-case", overwritten: true },
    });
  });
});
