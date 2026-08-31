import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalArtifactPath, resolveWorkspacePath } from "../../src/policy/path.js";
import { validateHistoryState, validateJobId, validateSubmit } from "../../src/policy/validator.js";
import type { Policy } from "../../src/policy/types.js";

const policy: Policy = {
  allowedPartitions: ["slurm-test"], maxNodes: 2, maxNtasks: 16, maxCpusPerTask: 8,
  maxMemoryGb: 64, maxGpus: 4, maxTimeMinutes: 240, maxWaitSeconds: 3600,
  maxHistoryDays: 30, maxHistoryJobs: 200,
  maxLogLines: 1000, maxLogBytes: 1048576,
  maxArtifactBytes: 104857600,
  allowedApptainerImages: { pytorch: "/opt/apptainer/pytorch.sif" },
  allowedVirtualenvs: { "project-a": "/opt/venvs/project-a" },
  allowedGres: { a100x1: "gpu:a100:1" },
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
  it("rejects excess GPUs, unknown GRES aliases, and simultaneous GPU selectors", () => {
    expect(() => validateSubmit({ ...valid, gpus: 5 }, policy)).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );
    expect(() => validateSubmit({ ...valid, gres: "unknown" }, policy)).toThrowError(
      expect.objectContaining({ code: "GRES_ALIAS_NOT_ALLOWED" }),
    );
    expect(() => validateSubmit({ ...valid, gpus: 1, gres: "a100x1" }, policy)).toThrow();
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
  it.each(["123;id", "1 && id", "--user", "1_2", "0", "-1", "1\n2"])(
    "rejects injected job ID %j", (jobId) => expect(() => validateJobId(jobId)).toThrow(),
  );
});

describe("history filters", () => {
  it("normalizes supported states", () => expect(validateHistoryState("completed")).toBe("COMPLETED"));
  it.each(["all", "COMPLETED,RUNNING", "$(id)", "NOT_A_STATE"])(
    "rejects unsupported state %j",
    (state) => expect(() => validateHistoryState(state)).toThrow(),
  );
});
