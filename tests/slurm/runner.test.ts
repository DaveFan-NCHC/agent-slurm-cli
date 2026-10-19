import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRUSTED_RUNNER } from "../../src/slurm/runner.js";

describe("trusted submission runner", () => {
  it("isolates Apptainer jobs and exposes only the per-job artifact directory", () => {
    expect(TRUSTED_RUNNER).toContain("--nv");
    expect(TRUSTED_RUNNER).toContain("--containall");
    expect(TRUSTED_RUNNER).toContain("--cleanenv");
    expect(TRUSTED_RUNNER).toContain('${SLURM_AGENT_WORKSPACE}:/workspace:ro');
    expect(TRUSTED_RUNNER).toContain('${SLURM_AGENT_INPUT_DIR}:/inputs:ro');
    expect(TRUSTED_RUNNER).toContain('${job_artifact_dir}:/artifacts:rw');
    expect(TRUSTED_RUNNER).not.toContain('${SLURM_AGENT_ARTIFACT_ROOT}:/artifacts');
    expect(TRUSTED_RUNNER).toContain("--env SLURM_AGENT_ARTIFACT_DIR=/artifacts");
    expect(TRUSTED_RUNNER).toContain("--env SLURM_AGENT_INPUT_DIR=/inputs");
  });

  it("passes script arguments without evaluating them", () => {
    expect(TRUSTED_RUNNER).toContain('/slurm-agent/submission/payload "$@"');
    expect(TRUSTED_RUNNER).toContain('exec "${SLURM_AGENT_PAYLOAD}" "$@"');
  });

  it("uses the stable array task ID for per-task artifacts", () => {
    expect(TRUSTED_RUNNER).toContain('artifact_job_id="${SLURM_ARRAY_JOB_ID}_${SLURM_ARRAY_TASK_ID}"');
    expect(TRUSTED_RUNNER).toContain('job_artifact_dir="${SLURM_AGENT_ARTIFACT_ROOT}/${artifact_job_id}"');
  });

  it("launches a fixed srun step and propagates validated placement", () => {
    expect(TRUSTED_RUNNER).toContain('exec "${SLURM_AGENT_SRUN_EXECUTABLE}" "$@"');
    expect(TRUSTED_RUNNER).toContain('"--nodes=${SLURM_AGENT_NODES}"');
    expect(TRUSTED_RUNNER).toContain('"--ntasks=${SLURM_AGENT_NTASKS}"');
    expect(TRUSTED_RUNNER).toContain('"--cpus-per-task=${SLURM_AGENT_CPUS_PER_TASK}"');
    expect(TRUSTED_RUNNER).toContain('"--gpus-per-task=${SLURM_AGENT_GPUS_PER_TASK}"');
    expect(TRUSTED_RUNNER).toContain('"--mpi=${SLURM_AGENT_MPI_MODE}"');
    expect(TRUSTED_RUNNER).toContain('eval "${module_commands}"');
    expect(TRUSTED_RUNNER).not.toContain('eval "$@"');
  });

  it("separates rank artifacts and preserves srun exit/signal propagation through exec", () => {
    expect(TRUSTED_RUNNER).toContain('job_artifact_dir="${job_artifact_dir}/ranks/${SLURM_PROCID}"');
    expect(TRUSTED_RUNNER).toContain('exec "${SLURM_AGENT_SRUN_EXECUTABLE}" "$@"');
  });

  it("is valid Bash syntax", () => {
    const checked = spawnSync("/bin/bash", ["-n"], { input: TRUSTED_RUNNER, encoding: "utf8" });
    expect(checked.status, checked.stderr).toBe(0);
  });

  it("loads selected modules in order without evaluating payload arguments", () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-modules-"));
    try {
      const artifacts = join(root, "artifacts");
      const inputs = join(root, "inputs");
      const runner = join(root, "runner");
      const payload = join(root, "payload");
      const modulecmd = join(root, "modulecmd");
      mkdirSync(artifacts);
      mkdirSync(inputs);
      writeFileSync(runner, TRUSTED_RUNNER);
      writeFileSync(payload, `#!/bin/sh\nset -eu\nprintf '%s\\n' "$LOADEDMODULES" "$@" > "$SLURM_AGENT_ARTIFACT_DIR/result"\n`);
      writeFileSync(modulecmd, `#!/bin/sh\nset -eu\n[ "$1" = bash ] && [ "$2" = load ]\nshift 2\nprintf "LOADEDMODULES='%s'; export LOADEDMODULES\\n" "$*"\n`);
      chmodSync(runner, 0o700);
      chmodSync(payload, 0o700);
      chmodSync(modulecmd, 0o700);

      const result = spawnSync(runner, ["literal;touch", "injected"], {
        cwd: root,
        env: {
          ...process.env,
          SLURM_JOB_ID: "124",
          SLURM_AGENT_PAYLOAD: payload,
          SLURM_AGENT_ARTIFACT_ROOT: artifacts,
          SLURM_AGENT_RUNTIME_KIND: "host",
          SLURM_AGENT_INPUT_DIR: inputs,
          SLURM_AGENT_LAUNCHER: "single",
          SLURM_AGENT_MODULECMD: modulecmd,
          SLURM_AGENT_MODULES: "gcc/12.2:cuda/12.1",
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(artifacts, "124", "result"), "utf8"))
        .toBe("gcc/12.2 cuda/12.1\nliteral;touch\ninjected\n");
      expect(existsSync(join(root, "injected"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes a controlled srun step and gives each rank a separate artifact directory", () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-runner-"));
    try {
      const artifacts = join(root, "artifacts");
      const inputs = join(root, "inputs");
      const runner = join(root, "runner");
      const payload = join(root, "payload");
      const srun = join(root, "srun");
      const capture = join(root, "srun-args");
      mkdirSync(artifacts);
      mkdirSync(inputs);
      writeFileSync(runner, TRUSTED_RUNNER);
      writeFileSync(payload, `#!/bin/sh\nset -eu\nprintf '%s\\n' "$SLURM_AGENT_INPUT_DIR" "$@" > "$SLURM_AGENT_ARTIFACT_DIR/result"\n`);
      writeFileSync(srun, `#!/bin/sh\nset -eu\nprintf '%s\\n' "$@" > "$SRUN_CAPTURE"\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in --*) shift ;; *) runner="$1"; shift; break ;; esac\ndone\nSLURM_AGENT_TASK_MODE=1 SLURM_PROCID=0 exec "$runner" "$@"\n`);
      chmodSync(runner, 0o700);
      chmodSync(payload, 0o700);
      chmodSync(srun, 0o700);

      const result = spawnSync(runner, ["--epochs", "2"], {
        env: {
          ...process.env,
          SLURM_JOB_ID: "123",
          SLURM_AGENT_PAYLOAD: payload,
          SLURM_AGENT_ARTIFACT_ROOT: artifacts,
          SLURM_AGENT_RUNTIME_KIND: "host",
          SLURM_AGENT_INPUT_DIR: inputs,
          SLURM_AGENT_LAUNCHER: "srun",
          SLURM_AGENT_SRUN_EXECUTABLE: srun,
          SLURM_AGENT_RUNNER: runner,
          SLURM_AGENT_NODES: "2",
          SLURM_AGENT_NTASKS: "4",
          SLURM_AGENT_CPUS_PER_TASK: "2",
          SLURM_AGENT_NTASKS_PER_NODE: "2",
          SLURM_AGENT_GPUS_PER_TASK: "1",
          SLURM_AGENT_MPI_MODE: "pmix",
          SLURM_AGENT_DISTRIBUTION: "block",
          SRUN_CAPTURE: capture,
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const args = readFileSync(capture, "utf8").trim().split("\n");
      expect(args).toEqual(expect.arrayContaining([
        "--nodes=2", "--ntasks=4", "--cpus-per-task=2", "--ntasks-per-node=2",
        "--gpus-per-task=1", "--mpi=pmix", "--distribution=block", runner,
      ]));
      expect(readFileSync(join(artifacts, "123", "ranks", "0", "result"), "utf8"))
        .toBe(`${inputs}\n--epochs\n2\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
