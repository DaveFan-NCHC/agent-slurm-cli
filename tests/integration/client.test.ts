import { describe, expect, it } from "vitest";
import { SlurmClient } from "../../src/slurm/client.js";
import type { Policy } from "../../src/policy/types.js";
import type { RemoteExecutor, RemoteResult, SafeCommand } from "../../src/transport/types.js";

const policy: Policy = {
  allowedPartitions: ["slurm-test"], maxNodes: 2, maxNtasks: 16, maxCpusPerTask: 8,
  maxMemoryGb: 64, maxGpus: 4, maxTimeMinutes: 240, maxWaitSeconds: 3600,
  maxHistoryDays: 30, maxHistoryJobs: 200,
  maxLogLines: 1000, maxLogBytes: 1024,
  maxArtifactBytes: 4096,
  allowedApptainerImages: { pytorch: "/opt/apptainer/pytorch.sif" },
  allowedVirtualenvs: { "project-a": "/opt/venvs/project-a" },
  allowedGres: { a100x1: "gpu:a100:1" },
  maxScriptBytes: 65536, maxScriptArgs: 32, maxScriptArgLength: 1024,
  requireApptainerForGeneratedScripts: false,
};

class MockExecutor implements RemoteExecutor {
  readonly commands: SafeCommand[] = [];
  readonly downloads: Array<{ remotePath: string; localPath: string; maxBytes: number }> = [];
  readonly uploads: Array<{ remotePath: string; content: Buffer; maxBytes: number }> = [];
  constructor(private readonly results: RemoteResult[]) {}
  async run(command: SafeCommand): Promise<RemoteResult> {
    this.commands.push(command);
    const result = this.results.shift();
    if (!result) throw new Error("Missing mock result");
    return result;
  }
  async downloadArtifact({ remotePath, localPath, maxBytes }: { remotePath: string; localPath: string; maxBytes: number }): Promise<{ bytes: number }> {
    this.downloads.push({ remotePath, localPath, maxBytes });
    return { bytes: 5 };
  }
  async uploadSubmission({ remotePath, content, maxBytes }: { remotePath: string; content: Buffer; maxBytes: number }): Promise<{ bytes: number }> {
    this.uploads.push({ remotePath, content, maxBytes });
    return { bytes: content.length };
  }
  async close(): Promise<void> {}
}

const ok = (stdout = ""): RemoteResult => ({ stdout, stderr: "", exitCode: 0 });
const prepared = { content: Buffer.from("#!/bin/sh\necho ok\n"), relativePath: "jobs/test.sh", sha256: "abc123" };

describe("Slurm client security boundaries", () => {
  it("constructs submit from validated fields and fixed log paths", async () => {
    const remote = new MockExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12345;cluster\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 4, cpusPerTask: 2,
      memory: "8G", time: "01:00:00", jobName: "test", memoryGb: 8, timeMinutes: 60,
      scriptArgs: ["--epochs", "20"],
    }, prepared)).resolves.toBe("12345");
    const submit = remote.commands.at(-1)!;
    expect(submit.executable).toBe("sbatch");
    expect(submit.args).toContain("--output=/work/.slurm-agent/logs/%j.out");
    expect(submit.args.find((argument) => argument.startsWith("--export="))).not.toContain("ALL");
    expect(submit.args.slice(-2)).toEqual(["--epochs", "20"]);
    expect(remote.uploads).toHaveLength(2);
    expect(remote.uploads[0]?.remotePath).toBe("/work/.slurm-agent/submissions/staged/payload");
  });

  it("queries only policy-allowed partitions for cluster information", async () => {
    const remote = new MockExecutor([
      ok("slurm-test*|up|04:00:00|2|idle|0/32/0/32|gpu:a100:4\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.clusterInfo()).resolves.toEqual([{
      partition: "slurm-test", availability: "up", time_limit: "04:00:00", nodes: 2,
      node_state: "idle", cpus: { allocated: 0, idle: 32, other: 0, total: 32 },
      gres: ["gpu:a100:4"],
    }]);
    expect(remote.commands[0]).toEqual({
      executable: "sinfo",
      args: ["--noheader", "--partition=slurm-test", "--format=%P|%a|%l|%D|%t|%C|%G"],
    });
  });

  it("fails closed if sinfo returns a partition outside policy", async () => {
    const remote = new MockExecutor([
      ok("admin|up|04:00:00|1|idle|0/16/0/16|(null)\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.clusterInfo()).rejects.toMatchObject({ code: "SLURM_QUERY_FAILED" });
  });

  it("lists bounded history for only the configured user", async () => {
    const first = [
      "43", "alice", "old", "slurm-test", "FAILED", "00:01:00",
      "2026-08-29T10:00:00", "2026-08-29T10:01:00", "1:0", "1", "1", "1Gn", "cpu=1,mem=1G,node=1",
    ].join("|");
    const second = [
      "44", "alice", "new", "slurm-test", "COMPLETED", "00:02:00",
      "2026-08-30T10:00:00", "2026-08-30T10:02:00", "0:0", "2", "1", "2Gn", "cpu=2,mem=2G,node=1",
    ].join("|");
    const remote = new MockExecutor([ok(`${first}\n${second}\n`)]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.history(7, "COMPLETED", 1)).resolves.toEqual([
      expect.objectContaining({ job_id: "44", state: "COMPLETED" }),
    ]);
    expect(remote.commands[0]).toMatchObject({ executable: "sacct", maxOutputBytes: 1048576 });
    expect(remote.commands[0]?.args).toContain("--user=alice");
    expect(remote.commands[0]?.args).toContain("--starttime=now-7days");
    expect(remote.commands[0]?.args).toContain("--state=COMPLETED");
  });

  it("rejects history rows returned for another user", async () => {
    const row = [
      "44", "mallory", "job", "slurm-test", "COMPLETED", "00:01:00",
      "2026-08-30T10:00:00", "2026-08-30T10:01:00", "0:0", "1", "1", "1Gn", "cpu=1,mem=1G,node=1",
    ].join("|");
    const client = new SlurmClient(new MockExecutor([ok(`${row}\n`)]), "alice", "/work", policy);
    await expect(client.history(7, undefined, 50)).rejects.toMatchObject({ code: "SLURM_QUERY_FAILED" });
  });

  it("reports completed job usage and derived efficiency", async () => {
    const allocation = [
      "44", "alice", "train", "slurm-test", "COMPLETED", "00:10:00", "600", "4", "1", "2Gn",
      "billing=4,cpu=4,mem=2G,node=1", "billing=4,cpu=4,mem=2G,node=1",
      "00:20:00", "", "", "", "", "0:0",
    ].join("|");
    const batch = [
      "44.batch", "alice", "batch", "slurm-test", "COMPLETED", "00:10:00", "600", "4", "1", "", "",
      "cpu=4,mem=2G", "00:20:00", "1G", "2G", "100M", "50M", "0:0",
    ].join("|");
    const remote = new MockExecutor([
      ok(""), ok("44|alice|train|slurm-test|COMPLETED|00:10:00|0:0\n"),
      ok(`${allocation}\n${batch}\n`),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.usage("44")).resolves.toMatchObject({
      job_id: "44", cpu_efficiency_percent: 50, memory_efficiency_percent: 50,
      live_available: false, steps: [{ step_id: "44.batch" }],
    });
    expect(remote.commands.at(-1)?.executable).toBe("sacct");
  });

  it("adds live sstat metrics for a running job", async () => {
    const allocation = [
      "44", "alice", "train", "slurm-test", "RUNNING", "00:05:00", "300", "4", "1", "2Gn",
      "billing=4,cpu=4,mem=2G,node=1", "billing=4,cpu=4,mem=2G,node=1",
      "00:05:00", "", "", "", "", "0:0",
    ].join("|");
    const remote = new MockExecutor([
      ok("44|alice|train|slurm-test|RUNNING|00:05:00\n"), ok(`${allocation}\n`),
      ok("44.batch|00:01:00|512M|1G|10M|5M|cpu=4,mem=2G\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.usage("44")).resolves.toMatchObject({
      state: "RUNNING", live_available: true,
      live_steps: [{ step_id: "44.batch", max_rss: "512M" }],
    });
    expect(remote.commands.at(-1)?.executable).toBe("sstat");
  });

  it("keeps accounting usage when live metrics have no steps", async () => {
    const allocation = [
      "44", "alice", "train", "slurm-test", "RUNNING", "00:05:00", "300", "4", "1", "2Gn",
      "billing=4,cpu=4,mem=2G,node=1", "billing=4,cpu=4,mem=2G,node=1",
      "00:05:00", "", "", "", "", "0:0",
    ].join("|");
    const remote = new MockExecutor([
      ok("44|alice|train|slurm-test|RUNNING|00:05:00\n"), ok(`${allocation}\n`), ok(),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.usage("44")).resolves.toMatchObject({
      state: "RUNNING", live_available: false, live_steps: [],
    });
  });

  it("passes validated GPU and GRES requests to sbatch", async () => {
    const makeRemote = () => new MockExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const gpuRemote = makeRemote();
    const client = new SlurmClient(gpuRemote, "alice", "/work", policy);
    await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10, gpus: 2, scriptArgs: [],
    }, prepared);
    expect(gpuRemote.commands.at(-1)?.args).toContain("--gpus=2");

    const gresRemote = makeRemote();
    const gresClient = new SlurmClient(gresRemote, "alice", "/work", policy);
    await gresClient.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      gres: "a100x1", gresValue: "gpu:a100:1", scriptArgs: [],
    }, prepared);
    expect(gresRemote.commands.at(-1)?.args).toContain("--gres=gpu:a100:1");
    expect(gresRemote.commands.at(-1)?.args).not.toContain("--gres=a100x1");
  });

  it("waits until an owned job reaches a terminal state", async () => {
    const remote = new MockExecutor([
      ok("44|alice|job|p|RUNNING|00:01\n"),
      ok(""), ok(""),
      ok(""),
      ok("44|alice|job|p|COMPLETED|00:01|0:0\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.wait("44", 1, 0)).resolves.toMatchObject({
      terminal: true, timed_out: false, job: { job_id: "44", state: "COMPLETED" },
    });
  });

  it("returns the last observed state when wait times out", async () => {
    const remote = new MockExecutor([ok("44|alice|job|p|RUNNING|00:01\n")]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.wait("44", 0, 0)).resolves.toMatchObject({
      terminal: false, timed_out: true, job: { job_id: "44", state: "RUNNING" },
    });
  });

  it("exports a policy-resolved Apptainer image", async () => {
    const remote = new MockExecutor([
      ok("/work\n"), ok("/opt/apptainer/pytorch.sif\n"), ok(),
      ok("/usr/bin/apptainer\n"), ok(), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      apptainerImage: "pytorch", apptainerImagePath: "/opt/apptainer/pytorch.sif",
      scriptArgs: [],
    }, prepared);
    const exported = remote.commands.at(-1)?.args.find((argument) => argument.startsWith("--export="));
    expect(exported).toContain("SLURM_AGENT_APPTAINER_IMAGE=/opt/apptainer/pytorch.sif");
    expect(exported).toContain("SLURM_AGENT_APPTAINER_EXECUTABLE=/usr/bin/apptainer");
    expect(exported).not.toContain("ALL");
  });

  it("exports a policy-resolved virtual environment after validating bin/python", async () => {
    const remote = new MockExecutor([
      ok("/work\n"), ok("/opt/venvs/project-a\n"), ok(), ok(), ok(),
      ok("/work/.slurm-agent/logs\n"), ok("/work/.slurm-agent/artifacts\n"),
      ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      venv: "project-a", venvPath: "/opt/venvs/project-a",
      scriptArgs: [],
    }, prepared);
    expect(remote.commands).toContainEqual({ executable: "test", args: ["-x", "/opt/venvs/project-a/bin/python"] });
    expect(remote.commands.filter((command) => command.executable === "test").every((command) => !command.args.includes("--"))).toBe(true);
    expect(remote.commands.at(-1)?.args.find((argument) => argument.startsWith("--export=")))
      .toContain("SLURM_AGENT_VENV=/opt/venvs/project-a");
  });

  it("rejects a missing policy-resolved runtime before sbatch", async () => {
    const remote = new MockExecutor([ok("/work\n"), { ...ok(), exitCode: 1 }]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      apptainerImage: "pytorch", apptainerImagePath: "/opt/apptainer/pytorch.sif",
      scriptArgs: [],
    }, prepared)).rejects.toMatchObject({ code: "RUNTIME_NOT_FOUND" });
    expect(remote.commands.some((command) => command.executable === "sbatch")).toBe(false);
  });

  it("rejects a log-directory symlink that resolves outside workspace", async () => {
    const remote = new MockExecutor([
      ok("/work\n"), ok(), ok("/tmp/stolen-logs\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10, scriptArgs: [],
    }, prepared)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(remote.commands.some((command) => command.executable === "sbatch")).toBe(false);
  });

  it("rejects an artifact-directory symlink that resolves outside workspace", async () => {
    const remote = new MockExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"), ok("/tmp/artifacts\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10, scriptArgs: [],
    }, prepared)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(remote.commands.some((command) => command.executable === "sbatch")).toBe(false);
  });

  it("refuses to cancel another user's job", async () => {
    const remote = new MockExecutor([ok("44|bob|job|p|RUNNING|00:01\n")]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.cancel("44")).rejects.toMatchObject({ code: "JOB_NOT_OWNED_BY_USER" });
    expect(remote.commands.some((command) => command.executable === "scancel")).toBe(false);
  });

  it("reads only the fixed per-job log after ownership and containment checks", async () => {
    const remote = new MockExecutor([
      ok("44|alice|job|p|RUNNING|00:01\n"), ok("/work\n"), ok("/work/.slurm-agent/logs/44.out\n"),
      { ...ok("hello\n"), stdoutTruncated: false },
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.logs("44", "stdout", 20)).resolves.toMatchObject({ content: "hello\n" });
    expect(remote.commands.at(-1)).toMatchObject({ executable: "tail", maxOutputBytes: 1024 });
  });

  it("downloads only from the owned job artifact directory", async () => {
    const remote = new MockExecutor([
      ok("44|alice|job|p|COMPLETED|00:01\n"), ok("/work\n"),
      ok("/work/.slurm-agent/artifacts/44\n"), ok("/work/.slurm-agent/artifacts/44/results/model.bin\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy, "/tmp/slurm-agent-test-artifacts");
    await expect(client.artifact("44", "results/model.bin")).resolves.toMatchObject({ bytes: 5 });
    expect(remote.downloads).toHaveLength(1);
    expect(remote.downloads[0]).toMatchObject({
      remotePath: "/work/.slurm-agent/artifacts/44/results/model.bin", maxBytes: 4096,
    });
    expect(remote.commands.some((command) => command.executable === "test")).toBe(false);
  });

  it("rejects artifact symlink escape before download", async () => {
    const remote = new MockExecutor([
      ok("44|alice|job|p|COMPLETED|00:01\n"), ok("/work\n"),
      ok("/work/.slurm-agent/artifacts/44\n"), ok("/etc/passwd\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy, "/tmp/slurm-agent-test-artifacts");
    await expect(client.artifact("44", "results/model.bin")).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(remote.downloads).toHaveLength(0);
  });

  it.each(["../secret", "/etc/passwd", "results/a;id", "results/a$(id)"])(
    "rejects artifact path %j before any remote operation", async (path) => {
      const remote = new MockExecutor([]);
      const client = new SlurmClient(remote, "alice", "/work", policy, "/tmp/slurm-agent-test-artifacts");
      await expect(client.artifact("44", path)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
      expect(remote.commands).toHaveLength(0);
      expect(remote.downloads).toHaveLength(0);
    },
  );
});
