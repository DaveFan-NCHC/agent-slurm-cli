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
allowed_modules:
  gcc: gcc/12.2.0
`);
    try {
      const policy = loadPolicy(fixture.path);
      expect(policy.allowedApptainerImages.pytorch).toBe("/opt/apptainer/pytorch.sif");
      expect(policy.allowedVirtualenvs["project-a"]).toBe("/opt/venvs/project-a");
      expect(policy.allowedModules.gcc).toBe("gcc/12.2.0");
      expect(policy.maxGpus).toBe(0);
      expect(policy.maxNtasksPerNode).toBe(0);
      expect(policy.maxGpusPerNode).toBe(0);
      expect(policy.maxGpusPerTask).toBe(0);
      expect(policy.allowExclusive).toBe(false);
      expect(policy.maxArtifactFiles).toBe(1000);
      expect(policy.allowedSignals).toEqual([]);
      expect(policy.maxWaitSeconds).toBe(86400);
      expect(policy.maxHistoryDays).toBe(30);
      expect(policy.maxHistoryJobs).toBe(200);
      expect(policy.maxListJobs).toBe(200);
      expect(policy.maxInputFiles).toBe(0);
      expect(policy.maxInputFileBytes).toBe(0);
      expect(policy.maxInputTotalBytes).toBe(0);
      expect(policy.maxArrayTasks).toBe(0);
      expect(policy.maxArrayConcurrency).toBe(0);
      expect(policy.maxDependencyJobs).toBe(0);
      expect(policy.allowedDependencyTypes).toEqual([]);
      expect(policy.allowedLaunchers).toEqual(["single"]);
      expect(policy.allowedMpiModes).toEqual([]);
      expect(policy.allowedDistributions).toEqual([]);
      expect(policy.allowedAccounts).toEqual({});
      expect(policy.allowedQos).toEqual({});
      expect(policy.allowedConstraints).toEqual({});
      expect(policy.allowedNodelists).toEqual({});
      expect(policy.allowedExcludeNodelists).toEqual({});
      expect(policy.allowedReservations).toEqual({});
    } finally { fixture.cleanup(); }
  });

  it.each(["../gcc", "gcc;id", "gcc module", "/absolute/module", "gcc//12"])(
    "rejects unsafe module name %j",
    (name) => {
      const fixture = policyFile(`${base}\nallowed_modules:\n  unsafe: '${name}'\n`);
      try { expect(() => loadPolicy(fixture.path)).toThrow(); }
      finally { fixture.cleanup(); }
    },
  );

  it("loads controlled Slurm submission aliases", () => {
    const fixture = policyFile(`${base}
allowed_accounts:
  research: proj123
allowed_qos:
  standard: normal
allowed_constraints:
  modern: '[zen3|zen4]'
allowed_nodelists:
  gpu-a: 'gpu[01-02]'
allowed_exclude_nodelists:
  maintenance: 'gpu[03,07-09]'
allowed_reservations:
  workshop: ws2026
`);
    try {
      const policy = loadPolicy(fixture.path);
      expect(policy.allowedAccounts.research).toBe("proj123");
      expect(policy.allowedQos.standard).toBe("normal");
      expect(policy.allowedConstraints.modern).toBe("[zen3|zen4]");
      expect(policy.allowedNodelists["gpu-a"]).toBe("gpu[01-02]");
      expect(policy.allowedExcludeNodelists.maintenance).toBe("gpu[03,07-09]");
      expect(policy.allowedReservations.workshop).toBe("ws2026");
    } finally { fixture.cleanup(); }
  });

  it.each([
    ["allowed_accounts", "bad;id"],
    ["allowed_qos", "normal,high"],
    ["allowed_reservations", "ws$(id)"],
    ["allowed_constraints", "gpu;id"],
    ["allowed_nodelists", "gpu[01];id"],
    ["allowed_exclude_nodelists", "gpu[01]$(id)"],
  ])("rejects unsafe controlled alias values in %s", (key, value) => {
    const fixture = policyFile(`${base}\n${key}:\n  unsafe: '${value}'\n`);
    try { expect(() => loadPolicy(fixture.path)).toThrow(); }
    finally { fixture.cleanup(); }
  });

  it("loads MPI, GPU, signal, wait, and GRES policy", () => {
    const fixture = policyFile(`${base}
max_ntasks_per_node: 8
max_gpus: 4
max_gpus_per_node: 2
max_gpus_per_task: 1
allow_exclusive: true
max_wait_seconds: 7200
max_history_days: 14
max_history_jobs: 75
max_list_jobs: 80
max_input_files: 64
max_input_file_bytes: 104857600
max_input_total_bytes: 536870912
max_array_tasks: 500
max_array_concurrency: 20
max_dependency_jobs: 4
allowed_dependency_types: [afterok, afterany]
allowed_launchers: [single, srun]
allowed_mpi_modes: [pmix, pmix_v3]
allowed_distributions: [block, cyclic]
max_artifact_files: 250
allowed_signals: [term, USR1]
allowed_gres:
  a100x2: gpu:a100:2
`);
    try {
      const policy = loadPolicy(fixture.path);
      expect(policy.maxGpus).toBe(4);
      expect(policy.maxNtasksPerNode).toBe(8);
      expect(policy.maxGpusPerNode).toBe(2);
      expect(policy.maxGpusPerTask).toBe(1);
      expect(policy.allowExclusive).toBe(true);
      expect(policy.maxWaitSeconds).toBe(7200);
      expect(policy.maxHistoryDays).toBe(14);
      expect(policy.maxHistoryJobs).toBe(75);
      expect(policy.maxListJobs).toBe(80);
      expect(policy.maxInputFiles).toBe(64);
      expect(policy.maxInputFileBytes).toBe(104857600);
      expect(policy.maxInputTotalBytes).toBe(536870912);
      expect(policy.maxArrayTasks).toBe(500);
      expect(policy.maxArrayConcurrency).toBe(20);
      expect(policy.maxDependencyJobs).toBe(4);
      expect(policy.allowedDependencyTypes).toEqual(["afterok", "afterany"]);
      expect(policy.allowedLaunchers).toEqual(["single", "srun"]);
      expect(policy.allowedMpiModes).toEqual(["pmix", "pmix_v3"]);
      expect(policy.allowedDistributions).toEqual(["block", "cyclic"]);
      expect(policy.maxArtifactFiles).toBe(250);
      expect(policy.allowedSignals).toEqual(["TERM", "USR1"]);
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
    ["allowed_launchers", "[single, shell]"],
    ["allowed_mpi_modes", "[pmix, 'pmix;id']"],
    ["allowed_distributions", "[block, arbitrary]"],
  ])("rejects unsafe or unsupported launcher policy in %s", (key, value) => {
    const fixture = policyFile(`${base}\n${key}: ${value}\n`);
    try { expect(() => loadPolicy(fixture.path)).toThrow(); }
    finally { fixture.cleanup(); }
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

  it.each(["[afterok, expand]", "[afterok, afterok]", "afterok"])(
    "rejects invalid dependency type policy %j",
    (types) => {
      const fixture = policyFile(`${base}\nallowed_dependency_types: ${types}\n`);
      try { expect(() => loadPolicy(fixture.path)).toThrow(); }
      finally { fixture.cleanup(); }
    },
  );

  it.each(["[KILL]", "[TERM, SIGTERM]", "TERM"])(
    "rejects invalid signal policy %j",
    (signals) => {
      const fixture = policyFile(`${base}\nallowed_signals: ${signals}\n`);
      try { expect(() => loadPolicy(fixture.path)).toThrow(); }
      finally { fixture.cleanup(); }
    },
  );
});
