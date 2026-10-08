import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareLocalScript } from "../../src/policy/script.js";
import type { Policy } from "../../src/policy/types.js";

const policy: Policy = {
  allowedPartitions: ["p"], maxNodes: 1, maxNtasks: 1, maxNtasksPerNode: 1, maxCpusPerTask: 1,
  maxMemoryGb: 1, maxGpus: 0, maxGpusPerNode: 0, maxGpusPerTask: 0, allowExclusive: false,
  maxTimeMinutes: 10, maxWaitSeconds: 60,
  maxHistoryDays: 7, maxHistoryJobs: 20, maxListJobs: 20,
  maxArrayTasks: 100, maxArrayConcurrency: 10, maxDependencyJobs: 8,
  allowedDependencyTypes: ["afterok", "afterany"],
  maxLogLines: 10, maxLogBytes: 1024,
  maxArtifactBytes: 1024, maxArtifactFiles: 10, allowedSignals: [],
  allowedApptainerImages: {}, allowedVirtualenvs: {},
  allowedGres: {},
  allowedAccounts: {}, allowedQos: {}, allowedConstraints: {}, allowedNodelists: {},
  allowedExcludeNodelists: {}, allowedReservations: {},
  maxScriptBytes: 128, maxScriptArgs: 4, maxScriptArgLength: 32,
  requireApptainerForGeneratedScripts: false,
};

describe("agent-generated local job scripts", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "slurm-agent-jobs-"));
    mkdirSync(join(workspace, "jobs"));
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("reads a safe script once and records its hash", () => {
    writeFileSync(join(workspace, "jobs", "train.sh"), "#!/bin/sh\necho 'hello; $(allowed)'\n");
    const script = prepareLocalScript(workspace, "jobs/train.sh", policy);
    expect(script.relativePath).toBe("jobs/train.sh");
    expect(script.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(["../secret.sh", "/etc/passwd", "jobs/a;id.sh"])("rejects path %j", (path) => {
    expect(() => prepareLocalScript(workspace, path, policy)).toThrow();
  });

  it("rejects symbolic links", () => {
    writeFileSync(join(workspace, "target.sh"), "#!/bin/sh\ntrue\n");
    symlinkSync(join(workspace, "target.sh"), join(workspace, "jobs", "link.sh"));
    expect(() => prepareLocalScript(workspace, "jobs/link.sh", policy)).toThrowError(
      expect.objectContaining({ code: "LOCAL_PATH_NOT_ALLOWED" }),
    );
  });

  it("rejects embedded SBATCH directives", () => {
    writeFileSync(join(workspace, "jobs", "bad.sh"), "#!/bin/sh\n#SBATCH --partition=admin\ntrue\n");
    expect(() => prepareLocalScript(workspace, "jobs/bad.sh", policy)).toThrowError(
      expect.objectContaining({ code: "SCRIPT_DIRECTIVES_NOT_ALLOWED" }),
    );
  });

  it("rejects oversized scripts", () => {
    writeFileSync(join(workspace, "jobs", "large.sh"), `#!/bin/sh\n${"x".repeat(200)}\n`);
    expect(() => prepareLocalScript(workspace, "jobs/large.sh", policy)).toThrowError(
      expect.objectContaining({ code: "SCRIPT_TOO_LARGE" }),
    );
  });

  it("requires a shebang", () => {
    writeFileSync(join(workspace, "jobs", "plain.sh"), "echo hello\n");
    expect(() => prepareLocalScript(workspace, "jobs/plain.sh", policy)).toThrowError(
      expect.objectContaining({ code: "SCRIPT_INVALID" }),
    );
  });
});
