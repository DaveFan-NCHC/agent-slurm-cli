import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli.js";
import type { RemoteExecutor, RemoteResult, SafeCommand, SafeSubmissionUpload } from "../../src/transport/types.js";

class Sink {
  value = "";
  write(chunk: string | Uint8Array): boolean { this.value += chunk.toString(); return true; }
}

class SubmitExecutor implements RemoteExecutor {
  readonly commands: SafeCommand[] = [];
  readonly uploads: SafeSubmissionUpload[] = [];
  private readonly results: RemoteResult[] = [
    { stdout: "/work\n", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: "/work/.slurm-agent/logs\n", stderr: "", exitCode: 0 },
    { stdout: "/work/.slurm-agent/artifacts\n", stderr: "", exitCode: 0 },
    { stdout: "/work/.slurm-agent/submissions/staged\n", stderr: "", exitCode: 0 },
    { stdout: "12345\n", stderr: "", exitCode: 0 },
  ];
  async run(command: SafeCommand): Promise<RemoteResult> {
    this.commands.push(command);
    return this.results.shift()!;
  }
  async uploadSubmission(upload: SafeSubmissionUpload): Promise<{ bytes: number }> {
    this.uploads.push(upload);
    return { bytes: upload.content.length };
  }
  async downloadArtifact(): Promise<{ bytes: number }> { return { bytes: 0 }; }
  async close(): Promise<void> {}
}

class QueryExecutor implements RemoteExecutor {
  readonly commands: SafeCommand[] = [];
  constructor(private readonly results: RemoteResult[]) {}
  async run(command: SafeCommand): Promise<RemoteResult> {
    this.commands.push(command);
    const result = this.results.shift();
    if (!result) throw new Error("Missing mock result");
    return result;
  }
  async uploadSubmission(): Promise<{ bytes: number }> { return { bytes: 0 }; }
  async downloadArtifact(): Promise<{ bytes: number }> { return { bytes: 0 }; }
  async close(): Promise<void> {}
}

describe("CLI boundary", () => {
  it.each(["exec", "ssh", "shell", "run", "command"])("does not expose %s", async (command) => {
    const stdout = new Sink();
    const stderr = new Sink();
    const code = await main([command, "id"], {}, stdout, stderr as never);
    expect(code).toBe(2);
    expect(JSON.parse(stdout.value)).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
  });
  it("prints help without loading credentials", async () => {
    const stdout = new Sink();
    expect(await main(["--help"], {}, stdout)).toBe(0);
    expect(stdout.value).toContain("slurm-agent submit");
  });
  it.each([
    ["submit", "--script", "jobs/a.sh", "--partition", "p", "--export", "ALL"],
    ["cancel", "1", "--user", "all"],
    ["list", "--partition", "gpu"],
    ["logs", "1", "--path", "/etc/passwd"],
    ["artifact", "1", "--output", "/etc/passwd"],
    ["artifact", "1", "--path", "../../etc/passwd", "--overwrite", "true"],
    ["cluster-info", "--partition", "gpu"],
    ["wait", "1", "--poll-interval", "0"],
  ])("rejects unexpected command options before loading credentials", async (...argv) => {
    const stdout = new Sink();
    const code = await main(argv, {}, stdout);
    expect(code).toBe(2);
    expect(JSON.parse(stdout.value)).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
  });

  it("accepts sbatch-like options, a positional local script, and script arguments", async () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-cli-"));
    try {
      mkdirSync(join(root, "jobs"));
      writeFileSync(join(root, "jobs", "train.sh"), "#!/bin/sh\necho train\n");
      writeFileSync(join(root, "key"), "test-key");
      writeFileSync(join(root, "known_hosts"), "host ssh-ed25519 AAAA\n");
      writeFileSync(join(root, "policy.yaml"), `
allowed_partitions: [p]
max_nodes: 2
max_ntasks: 4
max_cpus_per_task: 2
max_memory_gb: 8
max_gpus: 2
max_time_minutes: 60
max_wait_seconds: 60
allowed_gres:
  gpu1: gpu:1
require_apptainer_for_generated_scripts: false
`);
      const remote = new SubmitExecutor();
      const stdout = new Sink();
      const code = await main(
        ["submit", "-p", "p", "-N", "1", "-n", "1", "-c", "1", "--mem", "1G", "--gpus", "1", "-t", "00:10:00", "jobs/train.sh", "--epochs", "2"],
        {
          SLURM_SSH_HOST: "host", SLURM_SSH_USER: "alice", SLURM_SSH_KEY_PATH: join(root, "key"),
          SLURM_SSH_KNOWN_HOSTS: join(root, "known_hosts"), SLURM_REMOTE_WORKSPACE: "/work",
          SLURM_LOCAL_JOB_WORKSPACE: root, SLURM_POLICY_PATH: join(root, "policy.yaml"),
        },
        stdout,
        new Sink() as never,
        () => remote,
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.value)).toMatchObject({ ok: true, job_id: "12345" });
      expect(remote.commands.at(-1)?.args.slice(-2)).toEqual(["--epochs", "2"]);
      expect(remote.commands.at(-1)?.args).toContain("--gpus=1");
      expect(remote.uploads).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dispatches cluster-info and wait with structured JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-cli-query-"));
    try {
      writeFileSync(join(root, "key"), "test-key");
      writeFileSync(join(root, "known_hosts"), "host ssh-ed25519 AAAA\n");
      writeFileSync(join(root, "policy.yaml"), `
allowed_partitions: [p]
max_nodes: 2
max_ntasks: 4
max_cpus_per_task: 2
max_memory_gb: 8
max_gpus: 2
max_time_minutes: 60
max_wait_seconds: 60
require_apptainer_for_generated_scripts: false
`);
      const env = {
        SLURM_SSH_HOST: "host", SLURM_SSH_USER: "alice", SLURM_SSH_KEY_PATH: join(root, "key"),
        SLURM_SSH_KNOWN_HOSTS: join(root, "known_hosts"), SLURM_REMOTE_WORKSPACE: "/work",
        SLURM_POLICY_PATH: join(root, "policy.yaml"),
      };

      const clusterRemote = new QueryExecutor([
        { stdout: "p*|up|01:00:00|1|idle|0/8/0/8|(null)\n", stderr: "", exitCode: 0 },
      ]);
      const clusterOutput = new Sink();
      expect(await main(["cluster-info"], env, clusterOutput, new Sink() as never, () => clusterRemote)).toBe(0);
      expect(JSON.parse(clusterOutput.value)).toMatchObject({
        ok: true, partitions: [{ partition: "p", nodes: 1, gres: [] }],
      });

      const waitRemote = new QueryExecutor([
        { stdout: "", stderr: "", exitCode: 0 },
        { stdout: "44|alice|job|p|COMPLETED|00:01|0:0\n", stderr: "", exitCode: 0 },
      ]);
      const waitOutput = new Sink();
      expect(await main(
        ["wait", "44", "--timeout", "30", "--poll-interval", "1"],
        env, waitOutput, new Sink() as never, () => waitRemote,
      )).toBe(0);
      expect(JSON.parse(waitOutput.value)).toMatchObject({
        ok: true, terminal: true, timed_out: false, job: { job_id: "44", state: "COMPLETED" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
