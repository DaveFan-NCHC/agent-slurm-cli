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
    } finally { fixture.cleanup(); }
  });

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
