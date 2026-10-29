import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { QueryExecutor, Sink } from "../support/cli.js";

describe("CLI query boundary", () => {
  it("dispatches query commands with structured JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-slurm-cli-query-"));
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
allowed_apptainer_images:
  pytorch: /opt/apptainer/pytorch.sif
allowed_modules:
  gcc: gcc/12.2.0
allowed_accounts:
  research: proj123
require_apptainer_for_generated_scripts: false
`);
      const env = {
        SLURM_SSH_HOST: "host", SLURM_SSH_USER: "alice", SLURM_SSH_KEY_PATH: join(root, "key"),
        SLURM_SSH_KNOWN_HOSTS: join(root, "known_hosts"), SLURM_REMOTE_WORKSPACE: "/work",
        SLURM_POLICY_PATH: join(root, "policy.yaml"), SLURM_LOCAL_ARTIFACTS: join(root, "downloads"),
      };

      const policyRemote = new QueryExecutor([]);
      const policyOutput = new Sink();
      expect(await main(["policy"], env, policyOutput, new Sink() as never, () => policyRemote)).toBe(0);
      expect(JSON.parse(policyOutput.value)).toEqual({
        ok: true,
        policy: {
          allowed_partitions: ["p"],
          max_nodes: 2,
          max_ntasks: 4,
          max_ntasks_per_node: 4,
          max_cpus_per_task: 2,
          max_memory_gb: 8,
          max_gpus: 2,
          max_gpus_per_node: 2,
          max_gpus_per_task: 1,
          allow_exclusive: false,
          max_time_minutes: 60,
          max_wait_seconds: 60,
          max_history_days: 30,
          max_history_jobs: 100,
          max_list_jobs: 200,
          max_input_files: 0,
          max_input_file_bytes: 0,
          max_input_total_bytes: 0,
          max_array_tasks: 100,
          max_array_concurrency: 10,
          max_dependency_jobs: 8,
          allowed_dependency_types: ["afterok", "afterany", "afternotok"],
          allowed_launchers: ["single"],
          allowed_mpi_modes: [],
          allowed_distributions: [],
          max_log_lines: 1000,
          max_log_bytes: 1048576,
          max_artifact_bytes: 104857600,
          max_artifact_files: 100,
          allowed_signals: ["TERM", "USR1"],
          allowed_apptainer_images: { pytorch: "/opt/apptainer/pytorch.sif" },
          allowed_virtualenvs: {},
          allowed_modules: { gcc: "gcc/12.2.0" },
          allowed_gres: {},
          allowed_accounts: { research: "proj123" },
          allowed_qos: {},
          allowed_constraints: {},
          allowed_nodelists: {},
          allowed_exclude_nodelists: {},
          allowed_reservations: {},
          max_script_bytes: 65536,
          max_script_args: 32,
          max_script_arg_length: 1024,
          require_apptainer_for_generated_scripts: false,
        },
      });
      expect(policyRemote.commands).toEqual([]);

      const modulesRemote = new QueryExecutor([]);
      const modulesOutput = new Sink();
      expect(await main(["modules"], env, modulesOutput, new Sink() as never, () => modulesRemote)).toBe(0);
      expect(JSON.parse(modulesOutput.value)).toEqual({
        ok: true,
        modules: [{ alias: "gcc", name: "gcc/12.2.0" }],
      });
      expect(modulesRemote.commands).toEqual([]);

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

      const bundleRemote = new QueryExecutor([
        { stdout: "44|alice|job|p|COMPLETED|0:01\n", stderr: "", exitCode: 0 },
        { stdout: "/work\n", stderr: "", exitCode: 0 },
        { stdout: "/work/.slurm-agent/artifacts/44\n", stderr: "", exitCode: 0 },
        { stdout: "/work/.slurm-agent/artifacts/44/airfoil_unsteady/VTK\n", stderr: "", exitCode: 0 },
        { stdout: "", stderr: "", exitCode: 0 },
        { stdout: "", stderr: "", exitCode: 0 },
        { stdout: "/work/.slurm-agent/bundles\n", stderr: "", exitCode: 0 },
      ]);
      const bundleOutput = new Sink();
      expect(await main(
        ["artifacts", "44", "--download", "--prefix", "airfoil_unsteady/VTK", "--force"],
        env, bundleOutput, new Sink() as never, () => bundleRemote,
      )).toBe(0);
      expect(JSON.parse(bundleOutput.value)).toMatchObject({
        ok: true,
        bundle: {
          job_id: "44", format: "tar.gz", prefix: "airfoil_unsteady/VTK", bytes: 123,
          local_path: expect.stringMatching(/\/44\/artifacts-VTK-[a-f0-9]{8}\.tar\.gz$/),
          sha256: "b".repeat(64), overwritten: true,
        },
      });
      expect(bundleRemote.bundleDownloads).toHaveLength(1);
      expect(bundleRemote.bundleDownloads[0]).toMatchObject({
        remoteDirectory: "/work/.slurm-agent/artifacts/44",
        remoteArchivePath: expect.stringMatching(/^\/work\/\.slurm-agent\/bundles\/[0-9a-f-]+\.tar\.gz$/),
        localPath: expect.stringMatching(/\/44\/artifacts-VTK-[a-f0-9]{8}\.tar\.gz$/),
        maxBytes: 104857600,
        prefix: "airfoil_unsteady/VTK",
        overwrite: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

