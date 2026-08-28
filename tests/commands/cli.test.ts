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
max_time_minutes: 60
require_apptainer_for_generated_scripts: false
`);
      const remote = new SubmitExecutor();
      const stdout = new Sink();
      const code = await main(
        ["submit", "-p", "p", "-N", "1", "-n", "1", "-c", "1", "--mem", "1G", "-t", "00:10:00", "jobs/train.sh", "--epochs", "2"],
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
      expect(remote.uploads).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
