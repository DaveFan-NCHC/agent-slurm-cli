import { describe, expect, it } from "vitest";
import { SlurmClient } from "../../src/slurm/client.js";
import type { Policy } from "../../src/policy/types.js";
import type { RemoteExecutor, RemoteResult, SafeCommand } from "../../src/transport/types.js";

const policy: Policy = {
  allowedPartitions: ["slurm-test"], maxNodes: 2, maxNtasks: 16, maxCpusPerTask: 8,
  maxMemoryGb: 64, maxTimeMinutes: 240, maxLogLines: 1000, maxLogBytes: 1024,
};

class MockExecutor implements RemoteExecutor {
  readonly commands: SafeCommand[] = [];
  constructor(private readonly results: RemoteResult[]) {}
  async run(command: SafeCommand): Promise<RemoteResult> {
    this.commands.push(command);
    const result = this.results.shift();
    if (!result) throw new Error("Missing mock result");
    return result;
  }
  async close(): Promise<void> {}
}

const ok = (stdout = ""): RemoteResult => ({ stdout, stderr: "", exitCode: 0 });

describe("Slurm client security boundaries", () => {
  it("constructs submit from validated fields and fixed log paths", async () => {
    const remote = new MockExecutor([
      ok("/work\n"), ok("/work/jobs/test.sh\n"), ok(), ok(), ok("/work/.slurm-agent/logs\n"), ok("12345;cluster\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 4, cpusPerTask: 2,
      memory: "8G", time: "01:00:00", jobName: "test", memoryGb: 8, timeMinutes: 60,
    })).resolves.toBe("12345");
    const submit = remote.commands.at(-1)!;
    expect(submit.executable).toBe("sbatch");
    expect(submit.args).toContain("--output=/work/.slurm-agent/logs/%j.out");
    expect(submit.args.at(-1)).toBe("/work/jobs/test.sh");
  });

  it("rejects a script symlink that resolves outside workspace", async () => {
    const remote = new MockExecutor([ok("/work\n"), ok("/etc/passwd\n")]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
    })).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(remote.commands.some((command) => command.executable === "sbatch")).toBe(false);
  });

  it("rejects a log-directory symlink that resolves outside workspace", async () => {
    const remote = new MockExecutor([
      ok("/work\n"), ok("/work/jobs/test.sh\n"), ok(), ok(), ok("/tmp/stolen-logs\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", policy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
    })).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
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
});
