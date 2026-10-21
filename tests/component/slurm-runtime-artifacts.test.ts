import { describe, expect, it } from "vitest";
import { SlurmClient } from "../../src/slurm/client.js";
import {
  MockRemoteExecutor, ok, preparedScript, testPolicy,
} from "../support/slurm.js";

describe("Slurm runtime and artifact boundaries", () => {
  it("passes validated GPU and GRES requests to sbatch", async () => {
    const makeRemote = () => new MockRemoteExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const gpuRemote = makeRemote();
    const client = new SlurmClient(gpuRemote, "alice", "/work", testPolicy);
    await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10, gpus: 2, scriptArgs: [],
    }, preparedScript);
    expect(gpuRemote.commands.at(-1)?.args).toContain("--gpus=2");

    const gresRemote = makeRemote();
    const gresClient = new SlurmClient(gresRemote, "alice", "/work", testPolicy);
    await gresClient.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      gres: "a100x1", gresValue: "gpu:a100:1", scriptArgs: [],
    }, preparedScript);
    expect(gresRemote.commands.at(-1)?.args).toContain("--gres=gpu:a100:1");
    expect(gresRemote.commands.at(-1)?.args).not.toContain("--gres=a100x1");
  });

  it("waits until an owned job reaches a terminal state", async () => {
    const remote = new MockRemoteExecutor([
      ok("44|alice|job|p|RUNNING|00:01\n"),
      ok(""), ok(""),
      ok(""),
      ok("44|alice|job|p|COMPLETED|00:01|0:0\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.wait("44", 1, 0)).resolves.toMatchObject({
      terminal: true, timed_out: false, job: { job_id: "44", state: "COMPLETED" },
    });
  });

  it("returns the last observed state when wait times out", async () => {
    const remote = new MockRemoteExecutor([ok("44|alice|job|p|RUNNING|00:01\n")]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.wait("44", 0, 0)).resolves.toMatchObject({
      terminal: false, timed_out: true, job: { job_id: "44", state: "RUNNING" },
    });
  });

  it("exports a policy-resolved Apptainer image", async () => {
    const remote = new MockRemoteExecutor([
      ok("/work\n"), ok("/opt/apptainer/pytorch.sif\n"), ok(),
      ok("/usr/bin/apptainer\n"), ok(), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      apptainerImage: "pytorch", apptainerImagePath: "/opt/apptainer/pytorch.sif",
      scriptArgs: [],
    }, preparedScript);
    const exported = remote.commands.at(-1)?.args.find((argument) => argument.startsWith("--export="));
    expect(exported).toContain("SLURM_AGENT_APPTAINER_IMAGE=/opt/apptainer/pytorch.sif");
    expect(exported).toContain("SLURM_AGENT_APPTAINER_EXECUTABLE=/usr/bin/apptainer");
    expect(exported).not.toContain("ALL");
  });

  it("exports a policy-resolved virtual environment after validating bin/python", async () => {
    const remote = new MockRemoteExecutor([
      ok("/work\n"), ok("/opt/venvs/project-a\n"), ok(), ok(), ok(),
      ok("/work/.slurm-agent/logs\n"), ok("/work/.slurm-agent/artifacts\n"),
      ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      venv: "project-a", venvPath: "/opt/venvs/project-a",
      scriptArgs: [],
    }, preparedScript);
    expect(remote.commands).toContainEqual({ executable: "test", args: ["-x", "/opt/venvs/project-a/bin/python"] });
    expect(remote.commands.filter((command) => command.executable === "test").every((command) => !command.args.includes("--"))).toBe(true);
    expect(remote.commands.at(-1)?.args.find((argument) => argument.startsWith("--export=")))
      .toContain("SLURM_AGENT_VENV=/opt/venvs/project-a");
  });

  it("rejects a missing policy-resolved runtime before sbatch", async () => {
    const remote = new MockRemoteExecutor([ok("/work\n"), { ...ok(), exitCode: 1 }]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      apptainerImage: "pytorch", apptainerImagePath: "/opt/apptainer/pytorch.sif",
      scriptArgs: [],
    }, preparedScript)).rejects.toMatchObject({ code: "RUNTIME_NOT_FOUND" });
    expect(remote.commands.some((command) => command.executable === "sbatch")).toBe(false);
  });

  it("rejects a log-directory symlink that resolves outside workspace", async () => {
    const remote = new MockRemoteExecutor([
      ok("/work\n"), ok(), ok("/tmp/stolen-logs\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10, scriptArgs: [],
    }, preparedScript)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(remote.commands.some((command) => command.executable === "sbatch")).toBe(false);
  });

  it("rejects an artifact-directory symlink that resolves outside workspace", async () => {
    const remote = new MockRemoteExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"), ok("/tmp/artifacts\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10, scriptArgs: [],
    }, preparedScript)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(remote.commands.some((command) => command.executable === "sbatch")).toBe(false);
  });

  it("refuses to cancel another user's job", async () => {
    const remote = new MockRemoteExecutor([ok("44|bob|job|p|RUNNING|00:01\n")]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.cancel("44")).rejects.toMatchObject({ code: "JOB_NOT_OWNED_BY_USER" });
    expect(remote.commands.some((command) => command.executable === "scancel")).toBe(false);
  });

  it("cancels an owned array through its parent job ID", async () => {
    const remote = new MockRemoteExecutor([
      ok("44_0|alice|job|p|PENDING|00:00\n44_1|alice|job|p|RUNNING|00:01\n"), ok(),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.cancel("44")).resolves.toBeUndefined();
    expect(remote.commands.at(-1)).toEqual({ executable: "scancel", args: ["44"] });
  });

  it("requires an explicit array task ID for per-task operations", async () => {
    const remote = new MockRemoteExecutor([ok("44_0|alice|job|p|RUNNING|00:01\n")]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.getOwnedJob("44")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("reads only the fixed per-job log after ownership and containment checks", async () => {
    const remote = new MockRemoteExecutor([
      ok("44|alice|job|p|RUNNING|00:01\n"), ok("/work\n"), ok("/work/.slurm-agent/logs/44.out\n"),
      { ...ok("hello\n"), stdoutTruncated: false },
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.logs("44", "stdout", 20)).resolves.toMatchObject({ content: "hello\n" });
    expect(remote.commands.at(-1)).toMatchObject({ executable: "tail", maxOutputBytes: 1024 });
  });

  it("reads an individual array task log using its array task ID", async () => {
    const remote = new MockRemoteExecutor([
      ok("44_7|alice|job|p|RUNNING|00:01\n"), ok("/work\n"), ok("/work/.slurm-agent/logs/44_7.out\n"),
      { ...ok("task 7\n"), stdoutTruncated: false },
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.logs("44_7", "stdout", 20)).resolves.toMatchObject({
      job_id: "44_7", content: "task 7\n",
    });
  });

  it("downloads only from the owned job artifact directory", async () => {
    const remote = new MockRemoteExecutor([
      ok("44|alice|job|p|COMPLETED|00:01\n"), ok("/work\n"),
      ok("/work/.slurm-agent/artifacts/44\n"), ok("/work/.slurm-agent/artifacts/44/results/model.bin\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy, "/tmp/slurm-agent-test-artifacts");
    await expect(client.artifact("44", "results/model.bin")).resolves.toMatchObject({
      bytes: 5, sha256: "a".repeat(64), overwritten: false,
    });
    expect(remote.downloads).toHaveLength(1);
    expect(remote.downloads[0]).toMatchObject({
      remotePath: "/work/.slurm-agent/artifacts/44/results/model.bin", maxBytes: 4096,
    });
    expect(remote.commands.some((command) => command.executable === "test")).toBe(false);
  });

  it("streams a bounded archive of the owned job artifact directory", async () => {
    const remote = new MockRemoteExecutor([
      ok("44|alice|job|p|COMPLETED|00:01\n"), ok("/work\n"),
      ok("/work/.slurm-agent/artifacts/44\n"), ok(), ok("/work/.slurm-agent/bundles\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy, "/tmp/slurm-agent-test-artifacts");
    await expect(client.artifactBundle("44")).resolves.toMatchObject({
      job_id: "44", format: "tar.gz", bytes: 11,
      sha256: "b".repeat(64), overwritten: false,
      local_path: "/tmp/slurm-agent-test-artifacts/44/artifacts.tar.gz",
    });
    expect(remote.bundleDownloads).toHaveLength(1);
    expect(remote.bundleDownloads[0]).toMatchObject({
      remoteDirectory: "/work/.slurm-agent/artifacts/44",
      remoteArchivePath: expect.stringMatching(/^\/work\/\.slurm-agent\/bundles\/[0-9a-f-]+\.tar\.gz$/),
      localPath: "/tmp/slurm-agent-test-artifacts/44/artifacts.tar.gz",
      maxBytes: 4096,
    });
  });

  it("downloads a contained artifact prefix with a collision-resistant local name", async () => {
    const remote = new MockRemoteExecutor([
      ok("44|alice|job|p|COMPLETED|00:01\n"), ok("/work\n"),
      ok("/work/.slurm-agent/artifacts/44\n"),
      ok("/work/.slurm-agent/artifacts/44/airfoil_unsteady/VTK\n"), ok(),
      ok(), ok("/work/.slurm-agent/bundles\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy, "/tmp/slurm-agent-test-artifacts");
    await expect(client.artifactBundle("44", {
      prefix: "airfoil_unsteady/VTK", overwrite: true,
    })).resolves.toMatchObject({
      prefix: "airfoil_unsteady/VTK", overwritten: true,
      local_path: expect.stringMatching(/\/44\/artifacts-VTK-[a-f0-9]{8}\.tar\.gz$/),
    });
    expect(remote.bundleDownloads[0]).toMatchObject({
      prefix: "airfoil_unsteady/VTK", overwrite: true,
      remoteDirectory: "/work/.slurm-agent/artifacts/44",
    });
    expect(remote.commands).toContainEqual({
      executable: "test", args: ["-d", "/work/.slurm-agent/artifacts/44/airfoil_unsteady/VTK"],
    });
  });

  it("rejects an artifact prefix that resolves through a symlink", async () => {
    const remote = new MockRemoteExecutor([
      ok("44|alice|job|p|COMPLETED|00:01\n"), ok("/work\n"),
      ok("/work/.slurm-agent/artifacts/44\n"),
      ok("/work/.slurm-agent/artifacts/44/real-VTK\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy, "/tmp/slurm-agent-test-artifacts");
    await expect(client.artifactBundle("44", { prefix: "VTK" }))
      .rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(remote.bundleDownloads).toHaveLength(0);
  });

  it("rejects an artifact bundle directory outside the workspace", async () => {
    const remote = new MockRemoteExecutor([
      ok("44|alice|job|p|COMPLETED|00:01\n"), ok("/work\n"), ok("/etc\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy, "/tmp/slurm-agent-test-artifacts");
    await expect(client.artifactBundle("44")).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(remote.bundleDownloads).toHaveLength(0);
  });

  it("lists sorted regular-file artifacts after ownership and containment checks", async () => {
    const listing = ["z.bin", "2", "reports/result.txt", "12", ""].join("\0");
    const remote = new MockRemoteExecutor([
      ok("44|alice|job|p|COMPLETED|00:01\n"), ok("/work\n"),
      ok("/work/.slurm-agent/artifacts/44\n"), ok(listing),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.artifacts("44")).resolves.toEqual([
      { path: "reports/result.txt", bytes: 12 }, { path: "z.bin", bytes: 2 },
    ]);
    expect(remote.commands.at(-1)).toEqual({
      executable: "find",
      args: ["--", "/work/.slurm-agent/artifacts/44", "-xdev", "-type", "f", "-printf", String.raw`%P\0%s\0`],
      maxOutputBytes: 1048576,
    });
  });

  it("rejects artifact symlink escape before download", async () => {
    const remote = new MockRemoteExecutor([
      ok("44|alice|job|p|COMPLETED|00:01\n"), ok("/work\n"),
      ok("/work/.slurm-agent/artifacts/44\n"), ok("/etc/passwd\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy, "/tmp/slurm-agent-test-artifacts");
    await expect(client.artifact("44", "results/model.bin")).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(remote.downloads).toHaveLength(0);
  });

  it.each(["../secret", "/etc/passwd", "results/a;id", "results/a$(id)"])(
    "rejects artifact path %j before any remote operation", async (path) => {
      const remote = new MockRemoteExecutor([]);
      const client = new SlurmClient(remote, "alice", "/work", testPolicy, "/tmp/slurm-agent-test-artifacts");
      await expect(client.artifact("44", path)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
      expect(remote.commands).toHaveLength(0);
      expect(remote.downloads).toHaveLength(0);
    },
  );
});

