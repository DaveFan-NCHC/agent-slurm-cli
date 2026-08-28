export const TRUSTED_RUNNER = `#!/bin/sh
set -eu

: "\${SLURM_AGENT_PAYLOAD:?}"
: "\${SLURM_AGENT_ARTIFACT_ROOT:?}"
: "\${SLURM_AGENT_RUNTIME_KIND:?}"

job_artifact_dir="\${SLURM_AGENT_ARTIFACT_ROOT}/\${SLURM_JOB_ID}"
/bin/mkdir -p -m 700 "\${job_artifact_dir}"

case "\${SLURM_AGENT_RUNTIME_KIND}" in
  apptainer)
    : "\${SLURM_AGENT_APPTAINER_EXECUTABLE:?}"
    : "\${SLURM_AGENT_APPTAINER_IMAGE:?}"
    : "\${SLURM_AGENT_SUBMISSION_DIR:?}"
    : "\${SLURM_AGENT_WORKSPACE:?}"
    exec "\${SLURM_AGENT_APPTAINER_EXECUTABLE}" exec \
      --containall \
      --cleanenv \
      --bind "\${SLURM_AGENT_SUBMISSION_DIR}:/slurm-agent/submission:ro" \
      --bind "\${SLURM_AGENT_WORKSPACE}:/workspace:ro" \
      --bind "\${job_artifact_dir}:/artifacts:rw" \
      --pwd /workspace \
      --env SLURM_AGENT_ARTIFACT_DIR=/artifacts \
      "\${SLURM_AGENT_APPTAINER_IMAGE}" \
      /slurm-agent/submission/payload "$@"
    ;;
  venv)
    : "\${SLURM_AGENT_VENV:?}"
    export VIRTUAL_ENV="\${SLURM_AGENT_VENV}"
    export PATH="\${SLURM_AGENT_VENV}/bin:/usr/bin:/bin"
    export SLURM_AGENT_ARTIFACT_DIR="\${job_artifact_dir}"
    unset SLURM_AGENT_ARTIFACT_ROOT
    exec "\${SLURM_AGENT_PAYLOAD}" "$@"
    ;;
  host)
    export SLURM_AGENT_ARTIFACT_DIR="\${job_artifact_dir}"
    unset SLURM_AGENT_ARTIFACT_ROOT
    exec "\${SLURM_AGENT_PAYLOAD}" "$@"
    ;;
  *)
    exit 64
    ;;
esac
`;
