import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { QueryExecutor, Sink, SubmitExecutor } from "../support/cli.js";

describe("CLI submission boundary", () => {
  it("accepts sbatch-like options, a positional local script, and script arguments", async () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-cli-"));
    try {
      mkdirSync(join(root, "jobs"));
      mkdirSync(join(root, "config"));
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "jobs", "train.sh"), "#!/bin/sh\necho train\n");
      writeFileSync(join(root, "config", "run.yaml"), "x: 1\n");
      writeFileSync(join(root, "src", "model.py"), "model\n");
      writeFileSync(join(root, "key"), "test-key");
      writeFileSync(join(root, "known_hosts"), "host ssh-ed25519 AAAA\n");
      writeFileSync(join(root, "policy.yaml"), `
allowed_partitions: [p]
max_nodes: 2
max_ntasks: 4
max_ntasks_per_node: 4
max_cpus_per_task: 2
max_memory_gb: 8
max_gpus: 2
max_gpus_per_node: 2
max_gpus_per_task: 1
allow_exclusive: true
max_time_minutes: 60
max_wait_seconds: 60
max_history_days: 30
max_history_jobs: 100
max_input_files: 4
max_input_file_bytes: 1024
max_input_total_bytes: 2048
max_array_tasks: 100
max_array_concurrency: 10
max_dependency_jobs: 8
allowed_dependency_types: [afterok, afterany, afternotok]
allowed_gres:
  gpu1: gpu:1
allowed_accounts:
  research: proj123
allowed_qos:
  standard: normal
allowed_constraints:
  modern: '[zen3|zen4]'
allowed_nodelists:
  gpu-a: 'gpu[01-02]'
allowed_exclude_nodelists:
  maintenance: 'gpu[03,07-09]'
allowed_reservations:
  workshop: ws2026
allowed_modules:
  gcc: gcc/12.2.0
  cuda: cuda/12.1
require_apptainer_for_generated_scripts: false
`);
      const deniedOutput = new Sink();
      expect(await main(
        ["submit", "-p", "denied", "jobs/train.sh"],
        {
          SLURM_SSH_HOST: "host", SLURM_SSH_USER: "alice", SLURM_SSH_KEY_PATH: join(root, "key"),
          SLURM_SSH_KNOWN_HOSTS: join(root, "known_hosts"), SLURM_REMOTE_WORKSPACE: "/work",
          SLURM_LOCAL_JOB_WORKSPACE: root, SLURM_POLICY_PATH: join(root, "policy.yaml"),
        },
        deniedOutput,
        new Sink() as never,
        () => new QueryExecutor([]),
      )).toBe(3);
      expect(JSON.parse(deniedOutput.value)).toEqual({
        ok: false,
        error: {
          category: "POLICY_DENIED",
          code: "PARTITION_NOT_ALLOWED",
          message: "Partition denied is not permitted.",
        },
      });

      const remote = new SubmitExecutor();
      const stdout = new Sink();
      const code = await main(
        ["submit", "-p", "p", "-N", "1", "-n", "1", "--ntasks-per-node", "1", "-c", "1",
          "--mem-per-cpu", "1G", "--gpus-per-node", "1",
          "-A", "research", "--qos", "standard", "-C", "modern", "-w", "gpu-a",
          "-x", "maintenance", "--reservation", "workshop",
          "--array", "0-3%2", "-t", "00:10:00",
          "--input", "config/run.yaml", "--input=src/model.py", "jobs/train.sh", "--epochs", "2"],
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
      expect(JSON.parse(stdout.value)).toMatchObject({
        ok: true, job_id: "12345", array: { spec: "0-3%2", task_count: 4, concurrency: 2 },
        launcher: { mode: "single" }, inputs: { files: 2, bytes: 11 },
      });
      expect(remote.commands.at(-1)?.args.slice(-2)).toEqual(["--epochs", "2"]);
      expect(remote.commands.at(-1)?.args).toContain("--ntasks-per-node=1");
      expect(remote.commands.at(-1)?.args).toContain("--mem-per-cpu=1G");
      expect(remote.commands.at(-1)?.args).toContain("--gpus-per-node=1");
      expect(remote.commands.at(-1)?.args).toContain("--array=0-3%2");
      expect(remote.commands.at(-1)?.args).toContain("--account=proj123");
      expect(remote.commands.at(-1)?.args).toContain("--qos=normal");
      expect(remote.commands.at(-1)?.args).toContain("--constraint=[zen3|zen4]");
      expect(remote.commands.at(-1)?.args).toContain("--nodelist=gpu[01-02]");
      expect(remote.commands.at(-1)?.args).toContain("--exclude=gpu[03,07-09]");
      expect(remote.commands.at(-1)?.args).toContain("--reservation=ws2026");
      expect(remote.commands.at(-1)?.args).toContain("--output=/work/.slurm-agent/logs/%A_%a.out");
      expect(remote.uploads).toHaveLength(5);
      expect(remote.uploads.map((upload) => upload.label)).toEqual([
        "payload", "input", "input", "manifest", "runner",
      ]);

      const moduleRemote = new QueryExecutor([
        { stdout: "/work\n", stderr: "", exitCode: 0 },
        { stdout: "/usr/bin/modulecmd\n", stderr: "", exitCode: 0 },
        { stdout: "", stderr: "", exitCode: 0 },
        { stdout: "", stderr: "", exitCode: 0 },
        { stdout: "/work/.slurm-agent/logs\n", stderr: "", exitCode: 0 },
        { stdout: "/work/.slurm-agent/artifacts\n", stderr: "", exitCode: 0 },
        { stdout: "/work/.slurm-agent/submissions/staged\n", stderr: "", exitCode: 0 },
        { stdout: "12347\n", stderr: "", exitCode: 0 },
      ]);
      const moduleOutput = new Sink();
      expect(await main(
        ["submit", "-p", "p", "--module", "gcc", "--module", "cuda", "jobs/train.sh"],
        {
          SLURM_SSH_HOST: "host", SLURM_SSH_USER: "alice", SLURM_SSH_KEY_PATH: join(root, "key"),
          SLURM_SSH_KNOWN_HOSTS: join(root, "known_hosts"), SLURM_REMOTE_WORKSPACE: "/work",
          SLURM_LOCAL_JOB_WORKSPACE: root, SLURM_POLICY_PATH: join(root, "policy.yaml"),
        },
        moduleOutput,
        new Sink() as never,
        () => moduleRemote,
      )).toBe(0);
      expect(JSON.parse(moduleOutput.value)).toMatchObject({
        ok: true, job_id: "12347", modules: ["gcc", "cuda"],
      });
      expect(moduleRemote.commands.at(-1)?.args.find((argument) => argument.startsWith("--export=")))
        .toContain("SLURM_AGENT_MODULES=gcc/12.2.0:cuda/12.1");

      const dependencyRemote = new QueryExecutor([
        { stdout: "77|alice|prepare|p|RUNNING|00:01\n", stderr: "", exitCode: 0 },
        { stdout: "/work\n", stderr: "", exitCode: 0 },
        { stdout: "", stderr: "", exitCode: 0 },
        { stdout: "/work/.slurm-agent/logs\n", stderr: "", exitCode: 0 },
        { stdout: "/work/.slurm-agent/artifacts\n", stderr: "", exitCode: 0 },
        { stdout: "/work/.slurm-agent/submissions/staged\n", stderr: "", exitCode: 0 },
        { stdout: "12346\n", stderr: "", exitCode: 0 },
      ]);
      const dependencyOutput = new Sink();
      expect(await main(
        ["submit", "-p", "p", "--dependency", "afterok:77",
          "--artifact-input", "77:results/model.bin:model.bin", "jobs/train.sh"],
        {
          SLURM_SSH_HOST: "host", SLURM_SSH_USER: "alice", SLURM_SSH_KEY_PATH: join(root, "key"),
          SLURM_SSH_KNOWN_HOSTS: join(root, "known_hosts"), SLURM_REMOTE_WORKSPACE: "/work",
          SLURM_LOCAL_JOB_WORKSPACE: root, SLURM_POLICY_PATH: join(root, "policy.yaml"),
        },
        dependencyOutput,
        new Sink() as never,
        () => dependencyRemote,
      )).toBe(0);
      expect(JSON.parse(dependencyOutput.value)).toMatchObject({
        ok: true, job_id: "12346", dependency: "afterok:77",
        artifact_inputs: { files: 1, jobs: ["77"] },
      });
      expect(dependencyRemote.commands.at(-1)?.args).toContain("--dependency=afterok:77");

      const rejectedRemote = new SubmitExecutor({
        stdout: "",
        stderr: "\u001b[31msbatch: error:\u001b[0m Invalid account\u0000\n" + "x".repeat(5000),
        exitCode: 1,
      });
      const rejectedOutput = new Sink();
      expect(await main(
        ["submit", "-p", "p", "jobs/train.sh"],
        {
          SLURM_SSH_HOST: "host", SLURM_SSH_USER: "alice", SLURM_SSH_KEY_PATH: join(root, "key"),
          SLURM_SSH_KNOWN_HOSTS: join(root, "known_hosts"), SLURM_REMOTE_WORKSPACE: "/work",
          SLURM_LOCAL_JOB_WORKSPACE: root, SLURM_POLICY_PATH: join(root, "policy.yaml"),
        },
        rejectedOutput,
        new Sink() as never,
        () => rejectedRemote,
      )).toBe(5);
      const rejected = JSON.parse(rejectedOutput.value);
      expect(rejected).toMatchObject({
        ok: false,
        error: {
          code: "SLURM_SUBMIT_FAILED",
          message: "Slurm rejected the submission.",
          slurm_message_truncated: true,
        },
      });
      expect(rejected.error.slurm_message.startsWith("sbatch: error: Invalid account\n")).toBe(true);
      expect(rejected.error.slurm_message).not.toContain("\u001b");
      expect(Buffer.byteLength(rejected.error.slurm_message)).toBeLessThanOrEqual(4096);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


});

