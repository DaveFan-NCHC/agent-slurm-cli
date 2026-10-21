import { describe, expect, it } from "vitest";
import { SlurmClient } from "../../src/slurm/client.js";
import {
  FailingInputExecutor, MockRemoteExecutor, ok, preparedScript, testPolicy,
} from "../support/slurm.js";

describe("Slurm submission security boundaries", () => {
  it("exports only policy-resolved modules through a verified modulecmd executable", async () => {
    const remote = new MockRemoteExecutor([
      ok("/work\n"), ok("/usr/bin/modulecmd\n"), ok(), ok(),
      ok("/work/.slurm-agent/logs\n"), ok("/work/.slurm-agent/artifacts\n"),
      ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      modules: ["gcc", "cuda"], moduleValues: ["gcc/12.2", "cuda/12.1"],
      launcher: "single", scriptArgs: [],
    }, preparedScript);

    expect(remote.commands[1]).toEqual({ executable: "realpath", args: ["-e", "--", "/usr/bin/modulecmd"] });
    expect(remote.commands[2]).toEqual({ executable: "test", args: ["-x", "/usr/bin/modulecmd"] });
    const exported = remote.commands.at(-1)?.args.find((argument) => argument.startsWith("--export="));
    expect(exported).toContain("SLURM_AGENT_MODULECMD=/usr/bin/modulecmd");
    expect(exported).toContain("SLURM_AGENT_MODULES=gcc/12.2:cuda/12.1");
  });

  it("constructs submit from validated fields and fixed log paths", async () => {
    const remote = new MockRemoteExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12345;cluster\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 4, cpusPerTask: 2,
      memory: "8G", time: "01:00:00", jobName: "test", memoryGb: 8, timeMinutes: 60,
      scriptArgs: ["--epochs", "20"],
    }, preparedScript)).resolves.toBe("12345");
    const submit = remote.commands.at(-1)!;
    expect(submit.executable).toBe("sbatch");
    expect(submit.args).toContain("--output=/work/.slurm-agent/logs/%j.out");
    expect(submit.args.find((argument) => argument.startsWith("--export="))).not.toContain("ALL");
    expect(submit.args.slice(-2)).toEqual(["--epochs", "20"]);
    expect(remote.uploads).toHaveLength(2);
    expect(remote.uploads[0]?.remotePath).toBe("/work/.slurm-agent/submissions/staged/payload");
  });

  it("stages nested inputs and a final stable manifest before submission", async () => {
    const remote = new MockRemoteExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    const manifest = Buffer.from('{"version":1,"files":[]}\n');
    await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      launcher: "single", scriptArgs: [],
    }, preparedScript, {
      files: [
        { content: Buffer.from("model"), relativePath: "src/model.py", bytes: 5, sha256: "a".repeat(64) },
        { content: Buffer.from("x: 1\n"), relativePath: "config/run.yaml", bytes: 5, sha256: "b".repeat(64) },
      ],
      totalBytes: 10, manifest, manifestSha256: "c".repeat(64),
    });

    expect(remote.uploads.map((upload) => upload.label)).toEqual([
      "payload", "input", "input", "manifest", "runner",
    ]);
    expect(remote.uploads[1]).toMatchObject({ remotePath: expect.stringMatching(/\/inputs\/src\/model\.py$/), mode: 0o600 });
    expect(remote.uploads[2]).toMatchObject({ remotePath: expect.stringMatching(/\/inputs\/config\/run\.yaml$/), mode: 0o600 });
    expect(remote.uploads[3]).toMatchObject({ remotePath: expect.stringMatching(/\/input-manifest\.json$/), mode: 0o600 });
    const mkdir = remote.commands.find((command) => command.executable === "mkdir")!;
    expect(mkdir.args.some((argument) => argument.endsWith("/inputs/src"))).toBe(true);
    expect(mkdir.args.some((argument) => argument.endsWith("/inputs/config"))).toBe(true);
    expect(remote.commands.at(-1)?.args.find((argument) => argument.startsWith("--export=")))
      .toContain("SLURM_AGENT_INPUT_DIR=/work/.slurm-agent/submissions/staged/inputs");
  });

  it("records owned artifact inputs for bounded runtime staging", async () => {
    const remote = new MockRemoteExecutor([
      ok("77|alice|prepare|slurm-test|RUNNING|00:01\n"),
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      dependency: "afterok:77", dependencyJobIds: ["77"], launcher: "single", scriptArgs: [],
      artifactInputReferences: [
        { jobId: "77", sourcePath: "results/model.bin", destinationPath: "models/model.bin" },
      ],
    }, preparedScript, {
      files: [], totalBytes: 0, manifest: Buffer.from("{}\n"), manifestSha256: "a".repeat(64),
    });

    expect(remote.commands.filter((command) => command.executable === "squeue")).toHaveLength(1);
    expect(remote.uploads.map((upload) => upload.label)).toEqual([
      "payload", "artifact-input-manifest", "runner",
    ]);
    expect(remote.uploads[1]?.content.toString()).toBe("77|results/model.bin|models/model.bin\n");
    const exported = remote.commands.at(-1)?.args.find((argument) => argument.startsWith("--export="));
    expect(exported).toContain("SLURM_AGENT_ARTIFACT_INPUT_MANIFEST=/work/.slurm-agent/submissions/staged/artifact-input-manifest");
    expect(exported).toContain(`SLURM_AGENT_MAX_INPUT_FILE_BYTES=${testPolicy.maxInputFileBytes}`);
    expect(exported).toContain(`SLURM_AGENT_MAX_INPUT_TOTAL_BYTES=${testPolicy.maxInputTotalBytes}`);
  });

  it("rejects local and artifact inputs that target the same path", async () => {
    const remote = new MockRemoteExecutor([]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      launcher: "single", scriptArgs: [],
      artifactInputReferences: [
        { jobId: "77", sourcePath: "results/model.bin", destinationPath: "model.bin" },
      ],
    }, preparedScript, {
      files: [{ content: Buffer.from("local"), relativePath: "model.bin", bytes: 5, sha256: "a".repeat(64) }],
      totalBytes: 5, manifest: Buffer.from("{}\n"), manifestSha256: "b".repeat(64),
    })).rejects.toThrowError(expect.objectContaining({ code: "INPUT_INVALID" }));
    expect(remote.commands).toHaveLength(0);
  });

  it("never submits a job after a partial input upload", async () => {
    const remote = new FailingInputExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      launcher: "single", scriptArgs: [],
    }, preparedScript, {
      files: [{ content: Buffer.from("x"), relativePath: "data/x.bin", bytes: 1, sha256: "a".repeat(64) }],
      totalBytes: 1, manifest: Buffer.from("{}\n"), manifestSha256: "b".repeat(64),
    })).rejects.toThrow("simulated input upload failure");
    expect(remote.commands.some((command) => command.executable === "sbatch")).toBe(false);
    expect(remote.uploads.map((upload) => upload.label)).toEqual(["payload"]);
  });

  it("exports only validated srun launcher settings", async () => {
    const remote = new MockRemoteExecutor([
      ok("/work\n"), ok("/usr/bin/srun\n"), ok(), ok(),
      ok("/work/.slurm-agent/logs\n"), ok("/work/.slurm-agent/artifacts\n"),
      ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 2, ntasks: 4, ntasksPerNode: 2,
      cpusPerTask: 2, memory: "8G", time: "00:10:00", memoryGb: 8, timeMinutes: 10,
      gpusPerTask: 1, launcher: "srun", mpi: "pmix", distribution: "block", scriptArgs: [],
    }, preparedScript);

    expect(remote.commands[1]).toEqual({ executable: "realpath", args: ["-e", "--", "/usr/bin/srun"] });
    expect(remote.commands[2]).toEqual({ executable: "test", args: ["-x", "/usr/bin/srun"] });
    const exported = remote.commands.at(-1)?.args.find((argument) => argument.startsWith("--export="));
    expect(exported).toContain("SLURM_AGENT_LAUNCHER=srun");
    expect(exported).toContain("SLURM_AGENT_SRUN_EXECUTABLE=/usr/bin/srun");
    expect(exported).toContain("SLURM_AGENT_NODES=2");
    expect(exported).toContain("SLURM_AGENT_NTASKS=4");
    expect(exported).toContain("SLURM_AGENT_CPUS_PER_TASK=2");
    expect(exported).toContain("SLURM_AGENT_NTASKS_PER_NODE=2");
    expect(exported).toContain("SLURM_AGENT_GPUS_PER_TASK=1");
    expect(exported).toContain("SLURM_AGENT_MPI_MODE=pmix");
    expect(exported).toContain("SLURM_AGENT_DISTRIBUTION=block");
  });

  it("exposes bounded sanitized sbatch diagnostics when submission is rejected", async () => {
    const remote = new MockRemoteExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"),
      {
        stdout: "",
        stderr: "\u001b[31msbatch: error:\u001b[0m Invalid account\u0000\n" + "界".repeat(2000),
        exitCode: 1,
      },
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    const failure = await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10, scriptArgs: [],
    }, preparedScript).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "SLURM_SUBMIT_FAILED",
      details: {
        remote_exit_code: 1,
        slurm_message_truncated: true,
      },
    });
    expect(failure.details.slurm_message.startsWith("sbatch: error: Invalid account\n")).toBe(true);
    expect(failure.details.slurm_message).not.toContain("\u001b");
    expect(Buffer.byteLength(failure.details.slurm_message)).toBeLessThanOrEqual(4096);
  });

  it("passes policy-resolved scheduler aliases to sbatch", async () => {
    const remote = new MockRemoteExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10, scriptArgs: [],
      account: "research", accountValue: "proj123", qos: "normal", qosValue: "normal",
      constraint: "modern", constraintValue: "[zen3|zen4]",
      nodelist: "gpu-a", nodelistValue: "gpu[01-02]",
      exclude: "maintenance", excludeValue: "gpu[03,07-09]",
      reservation: "workshop", reservationValue: "ws2026",
    }, preparedScript);
    const args = remote.commands.at(-1)?.args ?? [];
    expect(args).toContain("--account=proj123");
    expect(args).toContain("--qos=normal");
    expect(args).toContain("--constraint=[zen3|zen4]");
    expect(args).toContain("--nodelist=gpu[01-02]");
    expect(args).toContain("--exclude=gpu[03,07-09]");
    expect(args).toContain("--reservation=ws2026");
    expect(args).not.toContain("--account=research");
    expect(args).not.toContain("--constraint=modern");
    expect(args).not.toContain("--nodelist=gpu-a");
    expect(args).not.toContain("--exclude=maintenance");
  });

  it("passes MPI topology, per-CPU memory, per-node GPUs, and exclusivity to sbatch", async () => {
    const remote = new MockRemoteExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 2, ntasks: 4, ntasksPerNode: 2,
      cpusPerTask: 2, memoryPerCpu: "2G", time: "00:10:00", memoryGb: 16, timeMinutes: 10,
      gpusPerNode: 2, scriptArgs: [],
    }, preparedScript);
    const args = remote.commands.at(-1)?.args ?? [];
    expect(args).toContain("--ntasks-per-node=2");
    expect(args).toContain("--mem-per-cpu=2G");
    expect(args.some((argument) => argument.startsWith("--mem="))).toBe(false);
    expect(args).toContain("--gpus-per-node=2");

    const exclusiveRemote = new MockRemoteExecutor([
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12346\n"),
    ]);
    const exclusiveClient = new SlurmClient(exclusiveRemote, "alice", "/work", testPolicy);
    await exclusiveClient.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "8G", time: "00:10:00", memoryGb: 8, timeMinutes: 10, exclusive: true, scriptArgs: [],
    }, preparedScript);
    expect(exclusiveRemote.commands.at(-1)?.args).toContain("--exclusive");
  });

  it("submits bounded arrays with owned dependencies and array-safe output paths", async () => {
    const remote = new MockRemoteExecutor([
      ok("77|alice|prepare|slurm-test|RUNNING|00:01\n"),
      ok("/work\n"), ok(), ok("/work/.slurm-agent/logs\n"),
      ok("/work/.slurm-agent/artifacts\n"), ok("/work/.slurm-agent/submissions/staged\n"), ok("12345\n"),
    ]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      array: "0-9%2", arrayTaskCount: 10, arrayConcurrency: 2,
      dependency: "afterok:77", dependencyJobIds: ["77"], scriptArgs: [],
    }, preparedScript)).resolves.toBe("12345");
    const submit = remote.commands.at(-1)!;
    expect(submit.args).toContain("--array=0-9%2");
    expect(submit.args).toContain("--dependency=afterok:77");
    expect(submit.args).toContain("--output=/work/.slurm-agent/logs/%A_%a.out");
    expect(submit.args).toContain("--error=/work/.slurm-agent/logs/%A_%a.err");
    expect(remote.commands[0]).toMatchObject({ executable: "squeue" });
  });

  it("rejects a dependency on another user's job before submission", async () => {
    const remote = new MockRemoteExecutor([ok("77|bob|prepare|slurm-test|RUNNING|00:01\n")]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10,
      dependency: "afterok:77", dependencyJobIds: ["77"], scriptArgs: [],
    }, preparedScript)).rejects.toMatchObject({ code: "JOB_NOT_OWNED_BY_USER" });
    expect(remote.commands.some((command) => command.executable === "sbatch")).toBe(false);
  });

  it("rejects an artifact input from another user's job before submission", async () => {
    const remote = new MockRemoteExecutor([ok("77|bob|prepare|slurm-test|RUNNING|00:01\n")]);
    const client = new SlurmClient(remote, "alice", "/work", testPolicy);
    await expect(client.submit({
      script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 1, cpusPerTask: 1,
      memory: "1G", time: "00:10:00", memoryGb: 1, timeMinutes: 10, scriptArgs: [],
      artifactInputReferences: [
        { jobId: "77", sourcePath: "results/model.bin", destinationPath: "model.bin" },
      ],
    }, preparedScript)).rejects.toMatchObject({ code: "JOB_NOT_OWNED_BY_USER" });
    expect(remote.commands.some((command) => command.executable === "sbatch")).toBe(false);
  });


});

