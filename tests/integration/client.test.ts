import { describe, expect, it } from "vitest";
import { SlurmClient } from "../../src/slurm/client.js";
import type { Policy } from "../../src/policy/types.js";
import type { RemoteExecutor, RemoteResult, SafeCommand } from "../../src/transport/types.js";

const policy: Policy = {
  allowedPartitions: ["slurm-test"], maxNodes: 2, maxNtasks: 16, maxCpusPerTask: 8,
  maxMemoryGb: 64, maxTimeMinutes: 240, maxLogLines: 1000, maxLogBytes: 1024,
  maxArtifactBytes: 4096,
  allowedApptainerImages: { pytorch: "/opt/apptainer/pytorch.sif" },
  allowedVirtualenvs: { "project-a": "/opt/venvs/project-a" },
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
    expect(remote.commands).toContainEqual({ executable: "test", args: ["-x", "--", "/opt/venvs/project-a/bin/python"] });
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
      ok("/work/.slurm-agent/artifacts/44\n"), ok("/work/.slurm-agent/artifacts/44/results/model.bin\n"), ok(),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy, "/tmp/slurm-agent-test-artifacts");
    await expect(client.artifact("44", "results/model.bin")).resolves.toMatchObject({ bytes: 5 });
    expect(remote.downloads).toHaveLength(1);
    expect(remote.downloads[0]).toMatchObject({
      remotePath: "/work/.slurm-agent/artifacts/44/results/model.bin", maxBytes: 4096,
    });
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
