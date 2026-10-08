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
  private readonly results: RemoteResult[];
  constructor(submitResult: RemoteResult = { stdout: "12345\n", stderr: "", exitCode: 0 }) {
    this.results = [
      { stdout: "/work\n", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "/work/.slurm-agent/logs\n", stderr: "", exitCode: 0 },
      { stdout: "/work/.slurm-agent/artifacts\n", stderr: "", exitCode: 0 },
      { stdout: "/work/.slurm-agent/submissions/staged\n", stderr: "", exitCode: 0 },
      submitResult,
    ];
  }
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
    ["list", "--sort", "%i"],
    ["logs", "1", "--path", "/etc/passwd"],
    ["artifact", "1", "--output", "/etc/passwd"],
    ["artifact", "1", "--path", "../../etc/passwd", "--overwrite", "true"],
    ["cluster-info", "--partition", "gpu"],
    ["nodes", "--state", "NOT_A_NODE_STATE"],
    ["wait", "1", "--poll-interval", "0"],
    ["history", "--days", "0"],
    ["history", "--state", "NOT_A_STATE"],
    ["usage", "1", "--user", "all"],
    ["update", "1"],
    ["signal", "1", "--signal", "TERM", "--scope", "children"],
    ["submit", "--partition", "p", "--exclusive=false", "jobs/a.sh"],
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
require_apptainer_for_generated_scripts: false
`);
      const remote = new SubmitExecutor();
      const stdout = new Sink();
      const code = await main(
        ["submit", "-p", "p", "-N", "1", "-n", "1", "--ntasks-per-node", "1", "-c", "1",
          "--mem-per-cpu", "1G", "--gpus-per-node", "1",
          "-A", "research", "--qos", "standard", "-C", "modern", "-w", "gpu-a",
          "-x", "maintenance", "--reservation", "workshop",
          "--array", "0-3%2", "-t", "00:10:00", "jobs/train.sh", "--epochs", "2"],
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
      expect(remote.uploads).toHaveLength(2);

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
        ["submit", "-p", "p", "--dependency", "afterok:77", "jobs/train.sh"],
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

  it("dispatches query commands with structured JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-cli-query-"));
    try {
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
max_time_minutes: 60
max_wait_seconds: 60
max_history_days: 30
max_history_jobs: 100
max_array_tasks: 100
max_array_concurrency: 10
max_dependency_jobs: 8
allowed_dependency_types: [afterok, afterany, afternotok]
max_artifact_files: 100
allowed_signals: [TERM, USR1]
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

      const nodesRemote = new QueryExecutor([
        { stdout: "node01|p*|up|idle|0/8/0/8|gpu:h200:1\n", stderr: "", exitCode: 0 },
      ]);
      const nodesOutput = new Sink();
      expect(await main(["nodes"], env, nodesOutput, new Sink() as never, () => nodesRemote)).toBe(0);
      expect(JSON.parse(nodesOutput.value)).toMatchObject({
        ok: true, nodes: [{ node_name: "node01", partition: "p", state: "idle", gres: ["gpu:h200:1"] }],
      });

      const historyRow = [
        "43", "alice", "old", "p", "COMPLETED", "00:01:00",
        "2026-08-30T10:00:00", "2026-08-30T10:01:00", "0:0", "1", "1", "1Gn", "cpu=1,mem=1G,node=1",
      ].join("|");
      const historyRemote = new QueryExecutor([{ stdout: `${historyRow}\n`, stderr: "", exitCode: 0 }]);
      const historyOutput = new Sink();
      expect(await main(
        ["history", "--days", "7", "--state", "completed", "--limit", "10"],
        env, historyOutput, new Sink() as never, () => historyRemote,
      )).toBe(0);
      expect(JSON.parse(historyOutput.value)).toMatchObject({
        ok: true,
        query: { days: 7, states: ["COMPLETED"], limit: 10, sort: "start_time_desc", array_view: "summary" },
        jobs: [{ job_id: "43" }],
      });

      const diagnoseActive = [
        "45", "alice", "job", "p", "PENDING", "0:00", "Priority", "100", "Unknown",
        "2026-10-08T09:00:00", "01:00:00", "01:00:00", "", "1", "1", "", "", "",
      ].join("|");
      const diagnoseRemote = new QueryExecutor([
        { stdout: `${diagnoseActive}\n`, stderr: "", exitCode: 0 },
        { stdout: "JobId=45 JobState=PENDING NumNodes=1 NumCPUs=1 ReqTRES=cpu=1,mem=1G,node=1", stderr: "", exitCode: 0 },
        { stdout: "45|100|10|0|80|0|10|0|0|0|0\n", stderr: "", exitCode: 0 },
      ]);
      const diagnoseOutput = new Sink();
      expect(await main(
        ["diagnose", "45"], env, diagnoseOutput, new Sink() as never, () => diagnoseRemote,
      )).toBe(0);
      expect(JSON.parse(diagnoseOutput.value)).toMatchObject({
        ok: true, job_id: "45", priority: { available: true },
        findings: [{ code: "WAITING_FOR_PRIORITY" }],
      });

      const usageRow = [
        "44", "alice", "job", "p", "COMPLETED", "00:01:00", "60", "1", "1", "1Gn",
        "cpu=1,mem=1G,node=1", "cpu=1,mem=1G,node=1", "00:00:30", "512M", "1G", "0", "0", "0:0",
      ].join("|");
      const usageRemote = new QueryExecutor([
        { stdout: "", stderr: "", exitCode: 0 },
        { stdout: "44|alice|job|p|COMPLETED|00:01:00|0:0\n", stderr: "", exitCode: 0 },
        { stdout: `${usageRow}\n`, stderr: "", exitCode: 0 },
      ]);
      const usageOutput = new Sink();
      expect(await main(["usage", "44"], env, usageOutput, new Sink() as never, () => usageRemote)).toBe(0);
      expect(JSON.parse(usageOutput.value)).toMatchObject({
        ok: true, usage: { job_id: "44", cpu_efficiency_percent: 50, memory_efficiency_percent: 50 },
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

      for (const [command, resultField] of [
        ["hold", "held"], ["release", "released"], ["requeue", "requeued"],
      ] as const) {
        const controlRemote = new QueryExecutor([
          { stdout: "44|alice|job|p|PENDING|0:00\n", stderr: "", exitCode: 0 },
          { stdout: "", stderr: "", exitCode: 0 },
        ]);
        const controlOutput = new Sink();
        expect(await main([command, "44"], env, controlOutput, new Sink() as never, () => controlRemote)).toBe(0);
        expect(JSON.parse(controlOutput.value)).toMatchObject({ ok: true, job_id: "44", [resultField]: true });
        expect(controlRemote.commands.at(-1)).toEqual({ executable: "scontrol", args: [command, "44"] });
      }

      const updateRemote = new QueryExecutor([
        { stdout: "44|alice|job|p|PENDING|0:00\n", stderr: "", exitCode: 0 },
        { stdout: "", stderr: "", exitCode: 0 },
      ]);
      const updateOutput = new Sink();
      expect(await main(
        ["update", "44", "--time", "00:30:00", "--array-concurrency", "4"],
        env, updateOutput, new Sink() as never, () => updateRemote,
      )).toBe(0);
      expect(JSON.parse(updateOutput.value)).toMatchObject({
        ok: true, job_id: "44", updated: { time: "00:30:00", array_concurrency: 4 },
      });
      expect(updateRemote.commands.at(-1)).toEqual({
        executable: "scontrol", args: ["update", "JobId=44", "TimeLimit=00:30:00", "ArrayTaskThrottle=4"],
      });

      const signalRemote = new QueryExecutor([
        { stdout: "44|alice|job|p|RUNNING|0:01\n", stderr: "", exitCode: 0 },
        { stdout: "", stderr: "", exitCode: 0 },
      ]);
      const signalOutput = new Sink();
      expect(await main(
        ["signal", "44", "--signal", "SIGUSR1", "--scope", "batch"],
        env, signalOutput, new Sink() as never, () => signalRemote,
      )).toBe(0);
      expect(JSON.parse(signalOutput.value)).toMatchObject({
        ok: true, job_id: "44", signalled: true, signal: "USR1", scope: "batch",
      });
      expect(signalRemote.commands.at(-1)).toEqual({
        executable: "scancel", args: ["--signal=USR1", "--batch", "44"],
      });

      const fairshareRemote = new QueryExecutor([{
        stdout: "proj123|alice|100|0.5|200|0.25|0.75|1.5|cpu=20|cpu=3\n", stderr: "", exitCode: 0,
      }]);
      const fairshareOutput = new Sink();
      expect(await main(
        ["fairshare"], env, fairshareOutput, new Sink() as never, () => fairshareRemote,
      )).toBe(0);
      expect(JSON.parse(fairshareOutput.value)).toMatchObject({
        ok: true, fairshare: [{ account: "proj123", user: "alice", fair_share: "0.75" }],
      });

      const artifactListing = ["model.bin", "42", "reports/metrics.json", "9", ""].join("\0");
      const artifactsRemote = new QueryExecutor([
        { stdout: "44|alice|job|p|COMPLETED|0:01\n", stderr: "", exitCode: 0 },
        { stdout: "/work\n", stderr: "", exitCode: 0 },
        { stdout: "/work/.slurm-agent/artifacts/44\n", stderr: "", exitCode: 0 },
        { stdout: artifactListing, stderr: "", exitCode: 0 },
      ]);
      const artifactsOutput = new Sink();
      expect(await main(
        ["artifacts", "44"], env, artifactsOutput, new Sink() as never, () => artifactsRemote,
      )).toBe(0);
      expect(JSON.parse(artifactsOutput.value)).toMatchObject({
        ok: true, job_id: "44", artifacts: [
          { path: "model.bin", bytes: 42 }, { path: "reports/metrics.json", bytes: 9 },
        ],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
