import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPolicy } from "../../src/policy/loader.js";

const base = `
allowed_partitions: [slurm-test]
max_nodes: 2
max_ntasks: 16
max_cpus_per_task: 8
max_memory_gb: 64
max_time_minutes: 240
`;

function policyFile(content: string): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "slurm-agent-policy-"));
  const path = join(directory, "policy.yaml");
  writeFileSync(path, content);
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

describe("runtime alias policy", () => {
  it("loads fixed Apptainer and virtualenv paths", () => {
    const fixture = policyFile(`${base}
allowed_apptainer_images:
  pytorch: /opt/apptainer/pytorch.sif
allowed_virtualenvs:
  project-a: /opt/venvs/project-a
`);
    try {
      const policy = loadPolicy(fixture.path);
      expect(policy.allowedApptainerImages.pytorch).toBe("/opt/apptainer/pytorch.sif");
      expect(policy.allowedVirtualenvs["project-a"]).toBe("/opt/venvs/project-a");
      expect(policy.maxGpus).toBe(0);
      expect(policy.maxWaitSeconds).toBe(86400);
      expect(policy.maxHistoryDays).toBe(30);
      expect(policy.maxHistoryJobs).toBe(200);
    } finally { fixture.cleanup(); }
  });

  it("loads GPU, wait, and GRES policy", () => {
    const fixture = policyFile(`${base}
max_gpus: 4
max_wait_seconds: 7200
max_history_days: 14
max_history_jobs: 75
allowed_gres:
  a100x2: gpu:a100:2
`);
    try {
      const policy = loadPolicy(fixture.path);
      expect(policy.maxGpus).toBe(4);
      expect(policy.maxWaitSeconds).toBe(7200);
      expect(policy.maxHistoryDays).toBe(14);
      expect(policy.maxHistoryJobs).toBe(75);
      expect(policy.allowedGres.a100x2).toBe("gpu:a100:2");
    } finally { fixture.cleanup(); }
  });

  it.each(["gpu:a100:0", "--gres=gpu:1", "gpu:a100:1,ALL", "gpu:a100:1;id"])(
    "rejects unsafe GRES request %j",
    (request) => {
      const fixture = policyFile(`${base}\nallowed_gres:\n  unsafe: ${request}\n`);
      try { expect(() => loadPolicy(fixture.path)).toThrow(); }
      finally { fixture.cleanup(); }
    },
  );

  it.each([
    "relative/image.sif",
    "/opt/image.sif,ALL",
    "/opt/../etc/passwd",
    "/opt/image with space.sif",
  ])("rejects unsafe fixed path %j", (path) => {
    const fixture = policyFile(`${base}\nallowed_apptainer_images:\n  pytorch: ${path}\n`);
    try { expect(() => loadPolicy(fixture.path)).toThrow(); }
    finally { fixture.cleanup(); }
  });

  it("rejects an unsafe alias", () => {
    const fixture = policyFile(`${base}\nallowed_virtualenvs:\n  bad,alias: /opt/venvs/a\n`);
    try { expect(() => loadPolicy(fixture.path)).toThrow(); }
    finally { fixture.cleanup(); }
  });
});
