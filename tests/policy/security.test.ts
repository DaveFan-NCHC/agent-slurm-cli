import { describe, expect, it } from "vitest";
import { resolveWorkspacePath } from "../../src/policy/path.js";
import { validateJobId, validateSubmit } from "../../src/policy/validator.js";
import type { Policy } from "../../src/policy/types.js";

const policy: Policy = {
  allowedPartitions: ["slurm-test"], maxNodes: 2, maxNtasks: 16, maxCpusPerTask: 8,
  maxMemoryGb: 64, maxTimeMinutes: 240, maxLogLines: 1000, maxLogBytes: 1048576,
};

const valid = {
  script: "jobs/test.sh", partition: "slurm-test", nodes: 1, ntasks: 4,
  cpusPerTask: 2, memory: "8G", time: "01:00:00", jobName: "test-job",
};

describe("workspace paths", () => {
  it.each(["../secret", "../../secret", "/etc/passwd", "jobs/../secret", "jobs//x", "jobs/a;id", "jobs/a$(id)", "jobs/a`id`", "jobs/a\nfile", "jobs/a|x", "jobs/a\\x"])(
    "rejects %j", (path) => expect(() => resolveWorkspacePath("/home/agent/workspace", path)).toThrow(),
  );
  it("resolves a safe relative path", () => {
    expect(resolveWorkspacePath("/home/agent/workspace", "jobs/test.sh")).toBe("/home/agent/workspace/jobs/test.sh");
  });
});

describe("resource policy", () => {
  it("accepts bounded resources", () => expect(validateSubmit(valid, policy).memoryGb).toBe(8));
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
