import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalArtifactPath, resolveWorkspacePath } from "../../src/policy/path.js";
import {
  validateArray, validateArrayView, validateArtifactInputs, validateDependency, validateHistorySort, validateHistoryState,
  validateHistoryWindow, validateJobId, validateJobSort, validateJobStates, validateNodeFeature,
  validateNodeState, validateQueryAccount, validateQueryName, validateQueryPartition, validateSignal,
  validateSubmit, validateUpdate,
} from "../../src/policy/validator.js";
import type { Policy } from "../../src/policy/types.js";

const policy: Policy = {
  allowedPartitions: ["slurm-test"], maxNodes: 2, maxNtasks: 16, maxNtasksPerNode: 8, maxCpusPerTask: 8,
  maxMemoryGb: 64, maxGpus: 4, maxGpusPerNode: 4, maxGpusPerTask: 2, allowExclusive: true,
  maxTimeMinutes: 240, maxWaitSeconds: 3600,
  maxHistoryDays: 30, maxHistoryJobs: 200, maxListJobs: 200,
  maxInputFiles: 64, maxInputFileBytes: 104857600, maxInputTotalBytes: 536870912,
  maxArrayTasks: 1000, maxArrayConcurrency: 32, maxDependencyJobs: 16,
  allowedDependencyTypes: ["after", "afterany", "aftercorr", "afternotok", "afterok", "singleton"],
  allowedLaunchers: ["single", "srun"], allowedMpiModes: ["pmix"],
  allowedDistributions: ["block", "cyclic"],
  maxLogLines: 1000, maxLogBytes: 1048576,
  maxArtifactBytes: 104857600, maxArtifactFiles: 1000, allowedSignals: ["TERM", "USR1"],
  allowedApptainerImages: { pytorch: "/opt/apptainer/pytorch.sif" },
  allowedVirtualenvs: { "project-a": "/opt/venvs/project-a" },
  allowedModules: { gcc: "gcc/12.2", cuda: "cuda/12.1" },
  allowedGres: { a100x1: "gpu:a100:1" },
  allowedAccounts: { research: "proj123" }, allowedQos: { normal: "normal" },
  allowedConstraints: { modern: "[zen3|zen4]" }, allowedNodelists: { "gpu-a": "gpu[01-02]" },
  allowedExcludeNodelists: { maintenance: "gpu[03,07-09]" },
  allowedReservations: { workshop: "ws2026" },
  maxScriptBytes: 65536, maxScriptArgs: 32, maxScriptArgLength: 1024,
  requireApptainerForGeneratedScripts: false,
};

const valid = {
  script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 4,
  cpusPerTask: 2, memory: "8G", time: "01:00:00", jobName: "test-job",
  scriptArgs: [],
};

describe("workspace paths", () => {
  it.each(["../secret", "../../secret", "/etc/passwd", "jobs/../secret", "jobs//x", "jobs/a;id", "jobs/a$(id)", "jobs/a`id`", "jobs/a\nfile", "jobs/a|x", "jobs/a\\x"])(
    "rejects %j", (path) => expect(() => resolveWorkspacePath("/home/agent/workspace", path)).toThrow(),
  );
  it("resolves a safe relative path", () => {
    expect(resolveWorkspacePath("/home/agent/workspace", "jobs/test.sh")).toBe("/home/agent/workspace/jobs/test.sh");
  });
  it("rejects local artifact symlink escape", () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-path-"));
    const outside = mkdtempSync(join(tmpdir(), "slurm-agent-outside-"));
    try {
      mkdirSync(join(root, "44"));
      symlinkSync(outside, join(root, "44", "escape"));
      expect(() => resolveLocalArtifactPath(root, "44", "escape/secret.bin")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it("refuses to overwrite a local artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-overwrite-"));
    try {
      const target = resolveLocalArtifactPath(root, "44", "results/model.bin");
      writeFileSync(target, "existing");
      expect(() => resolveLocalArtifactPath(root, "44", "results/model.bin")).toThrowError(
        expect.objectContaining({ code: "ARTIFACT_ALREADY_EXISTS" }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("allows --force only for an existing regular artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-force-"));
    try {
      const target = resolveLocalArtifactPath(root, "44", "results/model.bin");
      writeFileSync(target, "");
      expect(resolveLocalArtifactPath(root, "44", "results/model.bin", true)).toBe(target);
      symlinkSync(target, join(root, "44", "results", "model-link.bin"));
      expect(() => resolveLocalArtifactPath(root, "44", "results/model-link.bin", true)).toThrowError(
        expect.objectContaining({ code: "LOCAL_PATH_NOT_ALLOWED" }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parallel launcher policy", () => {
  it("preserves the single launcher default", () => {
    expect(validateSubmit(valid, policy)).toMatchObject({ launcher: "single" });
  });

  it("accepts only policy-approved srun modes and distributions", () => {
    expect(validateSubmit({ ...valid, launcher: "srun", mpi: "pmix", distribution: "block" }, policy))
      .toMatchObject({ launcher: "srun", mpi: "pmix", distribution: "block" });
    expect(() => validateSubmit({ ...valid, launcher: "srun", mpi: "pmi2" }, policy))
      .toThrowError(expect.objectContaining({ code: "MPI_MODE_NOT_ALLOWED" }));
    expect(() => validateSubmit({ ...valid, launcher: "srun", distribution: "arbitrary" }, policy)).toThrow();
  });

  it("rejects launcher-only options with single mode and disabled srun", () => {
    expect(() => validateSubmit({ ...valid, mpi: "pmix" }, policy)).toThrow();
    expect(() => validateSubmit(
      { ...valid, launcher: "srun" }, { ...policy, allowedLaunchers: ["single"] },
    )).toThrowError(expect.objectContaining({ code: "LAUNCHER_NOT_ALLOWED" }));
  });
});

describe("resource policy", () => {
  it("accepts bounded resources", () => expect(validateSubmit(valid, policy).memoryGb).toBe(8));
  it("maps an Apptainer alias to its fixed policy path", () => {
    expect(validateSubmit({ ...valid, apptainerImage: "pytorch" }, policy).apptainerImagePath)
      .toBe("/opt/apptainer/pytorch.sif");
  });
  it("maps a virtualenv alias to its fixed policy path", () => {
    expect(validateSubmit({ ...valid, venv: "project-a" }, policy).venvPath).toBe("/opt/venvs/project-a");
  });
  it("maps ordered module aliases to fixed module names", () => {
    expect(validateSubmit({ ...valid, modules: ["gcc", "cuda"] }, policy).moduleValues)
      .toEqual(["gcc/12.2", "cuda/12.1"]);
  });
  it.each(["unknown", "../gcc", "$(id)", "gcc,cuda"])("rejects module alias %j", (alias) => {
    expect(() => validateSubmit({ ...valid, modules: [alias] }, policy)).toThrow();
  });
  it("rejects duplicate modules and Apptainer module selection", () => {
    expect(() => validateSubmit({ ...valid, modules: ["gcc", "gcc"] }, policy)).toThrow();
    expect(() => validateSubmit({ ...valid, modules: ["gcc"], apptainerImage: "pytorch" }, policy)).toThrow();
  });
  it.each(["unknown", "/etc/passwd", "$(id)", "name,ALL"])("rejects Apptainer alias %j", (alias) => {
    expect(() => validateSubmit({ ...valid, apptainerImage: alias }, policy)).toThrow();
  });
  it("rejects simultaneous Apptainer and virtualenv selection", () => {
    expect(() => validateSubmit({ ...valid, apptainerImage: "pytorch", venv: "project-a" }, policy)).toThrow();
  });
  it("accepts bounded GPUs and resolves a GRES alias", () => {
    expect(validateSubmit({ ...valid, gpus: 2 }, policy).gpus).toBe(2);
    expect(validateSubmit({ ...valid, gres: "a100x1" }, policy).gresValue).toBe("gpu:a100:1");
  });
  it("accepts bounded MPI topology, per-CPU memory, and exclusive nodes", () => {
    expect(validateSubmit({
      ...valid, nodes: 2, ntasks: 4, ntasksPerNode: 2, cpusPerTask: 2,
      memory: undefined, memoryPerCpu: "2G",
    }, policy)).toMatchObject({ ntasksPerNode: 2, memoryGb: 16 });
    expect(validateSubmit({ ...valid, exclusive: true }, policy).exclusive).toBe(true);
  });
  it("accepts bounded per-node and per-task GPU requests", () => {
    expect(validateSubmit({ ...valid, nodes: 2, gpusPerNode: 2 }, policy).gpusPerNode).toBe(2);
    expect(validateSubmit({ ...valid, ntasks: 4, gpusPerTask: 1 }, policy).gpusPerTask).toBe(1);
  });
  it("resolves controlled scheduler aliases", () => {
    expect(validateSubmit({
      ...valid, account: "research", qos: "normal", constraint: "modern", nodelist: "gpu-a",
      exclude: "maintenance", reservation: "workshop",
    }, policy)).toMatchObject({
      accountValue: "proj123", qosValue: "normal", constraintValue: "[zen3|zen4]",
      nodelistValue: "gpu[01-02]", excludeValue: "gpu[03,07-09]", reservationValue: "ws2026",
    });
  });
  it.each([
    ["account", "ACCOUNT_ALIAS_NOT_ALLOWED"],
    ["qos", "QOS_ALIAS_NOT_ALLOWED"],
    ["constraint", "CONSTRAINT_ALIAS_NOT_ALLOWED"],
    ["nodelist", "NODELIST_ALIAS_NOT_ALLOWED"],
    ["exclude", "EXCLUDE_NODELIST_ALIAS_NOT_ALLOWED"],
    ["reservation", "RESERVATION_ALIAS_NOT_ALLOWED"],
  ] as const)("rejects an unknown %s alias", (field, code) => {
    expect(() => validateSubmit({ ...valid, [field]: "unknown" }, policy)).toThrowError(
      expect.objectContaining({ code }),
    );
  });
  it("rejects excess GPUs, unknown GRES aliases, and simultaneous GPU selectors", () => {
    expect(() => validateSubmit({ ...valid, gpus: 5 }, policy)).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );
    expect(() => validateSubmit({ ...valid, gres: "unknown" }, policy)).toThrowError(
      expect.objectContaining({ code: "GRES_ALIAS_NOT_ALLOWED" }),
    );
    expect(() => validateSubmit({ ...valid, gpus: 1, gres: "a100x1" }, policy)).toThrow();
    expect(() => validateSubmit({ ...valid, gpusPerNode: 1, gpusPerTask: 1 }, policy)).toThrow();
  });
  it("enforces MPI, GPU, memory, and exclusive-node policy boundaries", () => {
    expect(() => validateSubmit({ ...valid, nodes: 2, ntasks: 5, ntasksPerNode: 2 }, policy)).toThrow();
    expect(() => validateSubmit({ ...valid, ntasksPerNode: 9 }, policy)).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );
    expect(() => validateSubmit({ ...valid, nodes: 2, gpusPerNode: 3 }, policy)).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );
    expect(() => validateSubmit({ ...valid, ntasks: 4, gpusPerTask: 2 }, policy)).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );
    expect(() => validateSubmit({ ...valid, memoryPerCpu: "1G" }, policy)).toThrow();
    expect(() => validateSubmit({
      ...valid, memory: undefined, memoryPerCpu: "1G", exclusive: true,
    }, policy)).toThrow();
    expect(() => validateSubmit({
      ...valid, ntasks: 16, cpusPerTask: 8, memory: undefined, memoryPerCpu: "1G",
    }, policy)).toThrowError(expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }));
    expect(() => validateSubmit({ ...valid, exclusive: true }, { ...policy, allowExclusive: false }))
      .toThrowError(expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }));
  });
  it("can require an approved Apptainer runtime", () => {
    expect(() => validateSubmit(valid, { ...policy, requireApptainerForGeneratedScripts: true }))
      .toThrowError(expect.objectContaining({ code: "RUNTIME_REQUIRED" }));
  });
  it("validates script argument count, size, and control characters", () => {
    expect(() => validateSubmit({ ...valid, scriptArgs: new Array(33).fill("x") }, policy)).toThrow();
    expect(() => validateSubmit({ ...valid, scriptArgs: ["x".repeat(1025)] }, policy)).toThrow();
    expect(() => validateSubmit({ ...valid, scriptArgs: ["a\nb"] }, policy)).toThrow();
  });
  it.each([
    [{ ...valid, nodes: 3 }, "RESOURCE_LIMIT_EXCEEDED"],
    [{ ...valid, ntasks: 17 }, "RESOURCE_LIMIT_EXCEEDED"],
    [{ ...valid, cpusPerTask: 9 }, "RESOURCE_LIMIT_EXCEEDED"],
    [{ ...valid, memory: "65G" }, "RESOURCE_LIMIT_EXCEEDED"],
    [{ ...valid, time: "04:00:01" }, "TIME_LIMIT_EXCEEDED"],
    [{ ...valid, partition: "gpu" }, "PARTITION_NOT_ALLOWED"],
  ])("rejects a policy violation", (options, code) => {
    try { validateSubmit(options, policy); throw new Error("not rejected"); }
    catch (error) { expect((error as { code?: string }).code).toBe(code); }
  });
  it.each(["gpu;id", "gpu&&id", "gpu||id", "gpu|id", "$(id)", "`id`", "gpu\n-x", "gpu'", "--partition=gpu"])(
    "rejects injected partition %j", (partition) => expect(() => validateSubmit({ ...valid, partition }, policy)).toThrow(),
  );
  it("accepts individual array task IDs", () => expect(validateJobId("123_0")).toBe("123_0"));
  it.each(["123;id", "1 && id", "--user", "1_2_3", "1_[2]", "0", "-1", "1\n2"])(
    "rejects injected job ID %j", (jobId) => expect(() => validateJobId(jobId)).toThrow(),
  );
});

describe("job arrays and dependencies", () => {
  it("accepts bounded array ranges, steps, and concurrency", () => {
    expect(validateArray("0-9:2,20%3", policy)).toEqual({ value: "0-9:2,20%3", taskCount: 6, concurrency: 3 });
    expect(validateSubmit({ ...valid, array: "1-4%2" }, policy)).toMatchObject({
      array: "1-4%2", arrayTaskCount: 4, arrayConcurrency: 2,
    });
  });
  it.each(["", "1-", "3-1", "1::2", "1-4:0", "1,,2", "1%0", "1%2%3", "$(id)"])(
    "rejects invalid array specification %j",
    (array) => expect(() => validateArray(array, policy)).toThrow(),
  );
  it("enforces array task and concurrency policy", () => {
    expect(() => validateArray("0-1000%1", policy)).toThrowError(expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }));
    expect(() => validateArray("0-99", policy)).toThrowError(expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }));
    expect(() => validateArray("0-99%33", policy)).toThrowError(expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }));
  });
  it("accepts policy-approved dependency conditions and extracts unique references", () => {
    expect(validateDependency("afterok:123:456,afternotok:123,singleton", policy)).toEqual({
      value: "afterok:123:456,afternotok:123,singleton", jobIds: ["123", "456"],
      types: ["afterok", "afternotok", "singleton"],
    });
  });
  it.each(["", "afterok", "afterok:", "afterok:1;id", "afterok:1?afterany:2", "singleton:1", "aftercorr:1_2"])(
    "rejects invalid dependency %j",
    (dependency) => expect(() => validateDependency(dependency, policy)).toThrow(),
  );
  it("enforces dependency type and reference-count policy", () => {
    expect(() => validateDependency("expand:123", policy)).toThrowError(
      expect.objectContaining({ code: "DEPENDENCY_TYPE_NOT_ALLOWED" }),
    );
    const limited = { ...policy, maxDependencyJobs: 1 };
    expect(() => validateDependency("afterok:1:2", limited)).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );
    expect(() => validateDependency("singleton,singleton", limited)).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );
  });
  it("requires array context for aftercorr and an explicit name for singleton", () => {
    expect(() => validateSubmit({ ...valid, dependency: "aftercorr:123" }, policy)).toThrow();
    expect(() => validateSubmit({ ...valid, jobName: undefined, dependency: "singleton" }, policy)).toThrow();
    expect(validateSubmit({ ...valid, array: "0-3%2", dependency: "aftercorr:123" }, policy))
      .toMatchObject({ dependency: "aftercorr:123" });
  });
});

describe("artifact inputs", () => {
  it("normalizes upstream artifact references and defaults the destination to the source path", () => {
    expect(validateArtifactInputs([
      "123:results/model.bin:model.bin", "456_7:metrics/report.json",
    ], policy)).toEqual([
      { jobId: "123", sourcePath: "results/model.bin", destinationPath: "model.bin" },
      { jobId: "456_7", sourcePath: "metrics/report.json", destinationPath: "metrics/report.json" },
    ]);
    expect(validateSubmit({
      ...valid, artifactInputs: ["123:results/model.bin:model.bin"],
    }, policy).artifactInputReferences).toEqual([
      { jobId: "123", sourcePath: "results/model.bin", destinationPath: "model.bin" },
    ]);
  });

  it.each([
    "", "123", "123::model.bin", "123:../secret:model.bin", "123:model.bin:/absolute",
    "123:model.bin:bad|name", "1;id:model.bin", "123:model.bin:a:b",
  ])("rejects unsafe artifact input %j", (reference) => {
    expect(() => validateArtifactInputs([reference], policy)).toThrow();
  });

  it("rejects duplicate destinations and policy-exceeding counts", () => {
    expect(() => validateArtifactInputs([
      "123:a.bin:model.bin", "456:b.bin:model.bin",
    ], policy)).toThrow();
    expect(() => validateArtifactInputs(
      ["123:a.bin", "124:b.bin"], { ...policy, maxInputFiles: 1 },
    )).toThrowError(expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }));
  });
});

describe("safe job updates and signals", () => {
  it("normalizes bounded update values and extracts dependency ownership checks", () => {
    expect(validateUpdate({
      time: "02:00:00", dependency: "afterok:123:456", arrayConcurrency: 8,
    }, policy)).toMatchObject({
      timeMinutes: 120, dependencyJobIds: ["123", "456"], arrayConcurrency: 8,
    });
  });
  it("rejects empty, unsafe, and over-policy updates", () => {
    expect(() => validateUpdate({}, policy)).toThrow();
    expect(() => validateUpdate({ arrayConcurrency: 0 }, policy)).toThrow();
    expect(() => validateUpdate({ arrayConcurrency: 33 }, policy)).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );
    expect(() => validateUpdate({ time: "04:00:01" }, policy)).toThrowError(
      expect.objectContaining({ code: "TIME_LIMIT_EXCEEDED" }),
    );
    expect(() => validateUpdate({ dependency: "aftercorr:123" }, policy)).toThrow();
  });
  it("normalizes SIG prefixes and enforces the signal allowlist and scope", () => {
    expect(validateSignal("sigusr1", "full", policy)).toEqual({ signal: "USR1", scope: "full" });
    expect(validateSignal("TERM", "steps", policy)).toEqual({ signal: "TERM", scope: "steps" });
    expect(() => validateSignal("KILL", "steps", policy)).toThrowError(
      expect.objectContaining({ code: "SIGNAL_NOT_ALLOWED" }),
    );
    expect(() => validateSignal("TERM", "children", policy)).toThrow();
  });
});

describe("history filters", () => {
  it("normalizes supported states", () => expect(validateHistoryState("completed")).toBe("COMPLETED"));
  it.each(["all", "COMPLETED,RUNNING", "$(id)", "NOT_A_STATE"])(
    "rejects unsupported state %j",
    (state) => expect(() => validateHistoryState(state)).toThrow(),
  );
  it("accepts bounded multi-state and explicit time filters", () => {
    expect(validateJobStates("completed,failed")).toEqual(["COMPLETED", "FAILED"]);
    expect(validateHistoryWindow("2026-10-01T00:00:00", "2026-10-08T00:00:00", policy)).toEqual({
      since: "2026-10-01T00:00:00", until: "2026-10-08T00:00:00",
    });
  });
  it("rejects unsafe or over-policy query filters", () => {
    expect(() => validateHistoryWindow("2026-01-01T00:00:00", "2026-10-08T00:00:00", policy)).toThrow();
    expect(() => validateHistoryWindow("2026-10-08", "2026-10-09", policy)).toThrow();
    expect(() => validateHistoryWindow("2026-02-30T00:00:00", "2026-03-01T00:00:00", policy)).toThrow();
    expect(() => validateQueryPartition("admin", policy)).toThrowError(
      expect.objectContaining({ code: "PARTITION_NOT_ALLOWED" }),
    );
    expect(() => validateQueryAccount("unknown", policy)).toThrowError(
      expect.objectContaining({ code: "ACCOUNT_ALIAS_NOT_ALLOWED" }),
    );
    expect(() => validateQueryName("name;id")).toThrow();
    expect(() => validateJobSort("%i")).toThrow();
    expect(() => validateHistorySort("Start desc")).toThrow();
    expect(() => validateArrayView("all")).toThrow();
  });
  it("validates node state and concrete feature aliases", () => {
    expect(validateNodeState("idle")).toBe("IDLE");
    expect(() => validateNodeState("idle,down")).toThrow();
    expect(validateNodeFeature("zen4", {
      ...policy, allowedConstraints: { ...policy.allowedConstraints, zen4: "zen4" },
    })).toBe("zen4");
    expect(() => validateNodeFeature("modern", policy)).toThrow();
  });
});
