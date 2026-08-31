import { describe, expect, it } from "vitest";
import { TRUSTED_RUNNER } from "../../src/slurm/runner.js";

describe("trusted submission runner", () => {
  it("isolates Apptainer jobs and exposes only the per-job artifact directory", () => {
    expect(TRUSTED_RUNNER).toContain("--containall");
    expect(TRUSTED_RUNNER).toContain("--cleanenv");
    expect(TRUSTED_RUNNER).toContain('${SLURM_AGENT_WORKSPACE}:/workspace:ro');
    expect(TRUSTED_RUNNER).toContain('${job_artifact_dir}:/artifacts:rw');
    expect(TRUSTED_RUNNER).not.toContain('${SLURM_AGENT_ARTIFACT_ROOT}:/artifacts');
    expect(TRUSTED_RUNNER).toContain("--env SLURM_AGENT_ARTIFACT_DIR=/artifacts");
  });

  it("passes script arguments without evaluating them", () => {
    expect(TRUSTED_RUNNER).toContain('/slurm-agent/submission/payload "$@"');
    expect(TRUSTED_RUNNER).toContain('exec "${SLURM_AGENT_PAYLOAD}" "$@"');
  });

  it("uses the stable array task ID for per-task artifacts", () => {
    expect(TRUSTED_RUNNER).toContain('artifact_job_id="${SLURM_ARRAY_JOB_ID}_${SLURM_ARRAY_TASK_ID}"');
    expect(TRUSTED_RUNNER).toContain('job_artifact_dir="${SLURM_AGENT_ARTIFACT_ROOT}/${artifact_job_id}"');
  });
});
