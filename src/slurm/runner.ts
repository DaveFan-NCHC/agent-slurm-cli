export const TRUSTED_RUNNER = `#!/bin/bash
set -eu

: "\${SLURM_AGENT_PAYLOAD:?}"
: "\${SLURM_AGENT_ARTIFACT_ROOT:?}"
: "\${SLURM_AGENT_RUNTIME_KIND:?}"
: "\${SLURM_AGENT_INPUT_DIR:?}"
: "\${SLURM_AGENT_LAUNCHER:?}"

task_mode="\${SLURM_AGENT_TASK_MODE:-0}"
case "\${task_mode}" in
  0|1) ;;
  *) exit 64 ;;
esac

artifact_job_id="\${SLURM_JOB_ID}"
if [ -n "\${SLURM_ARRAY_JOB_ID:-}" ]; then
  : "\${SLURM_ARRAY_TASK_ID:?}"
  artifact_job_id="\${SLURM_ARRAY_JOB_ID}_\${SLURM_ARRAY_TASK_ID}"
fi
job_artifact_dir="\${SLURM_AGENT_ARTIFACT_ROOT}/\${artifact_job_id}"
/bin/mkdir -p -m 700 "\${job_artifact_dir}"

if [ "\${task_mode}" = 0 ] && [ -n "\${SLURM_AGENT_ARTIFACT_INPUT_MANIFEST:-}" ]; then
  : "\${SLURM_AGENT_MAX_INPUT_FILE_BYTES:?}"
  : "\${SLURM_AGENT_MAX_INPUT_TOTAL_BYTES:?}"
  artifact_input_total="\${SLURM_AGENT_STAGED_INPUT_BYTES:-0}"
  case "\${SLURM_AGENT_MAX_INPUT_FILE_BYTES}:\${SLURM_AGENT_MAX_INPUT_TOTAL_BYTES}:\${artifact_input_total}" in
    *[!0-9:]*) exit 64 ;;
  esac
  input_root_real="$(realpath -e -- "\${SLURM_AGENT_INPUT_DIR}")" || exit 66
  manifest_real="$(realpath -e -- "\${SLURM_AGENT_ARTIFACT_INPUT_MANIFEST}")" || exit 66
  if [ "\${manifest_real}" != "\${SLURM_AGENT_ARTIFACT_INPUT_MANIFEST}" ] || [ ! -f "\${manifest_real}" ]; then
    exit 66
  fi
  while IFS='|' read -r source_job_id source_relative destination_relative extra; do
    if [ -n "\${extra}" ] ||
       ! [[ "\${source_job_id}" =~ ^[1-9][0-9]*(_[0-9]+)?$ ]] ||
       ! [[ "\${source_relative}" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] ||
       ! [[ "\${destination_relative}" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]]; then
      exit 64
    fi
    case "/\${source_relative}/:/\${destination_relative}/" in
      */./*|*/../*) exit 64 ;;
    esac
    source_path="\${SLURM_AGENT_ARTIFACT_ROOT}/\${source_job_id}/\${source_relative}"
    source_real="$(realpath -e -- "\${source_path}")" || {
      echo "Artifact input is unavailable: \${source_job_id}:\${source_relative}" >&2
      exit 66
    }
    if [ "\${source_real}" != "\${source_path}" ] || [ ! -f "\${source_real}" ]; then
      echo "Artifact input is not a safe regular file: \${source_job_id}:\${source_relative}" >&2
      exit 66
    fi
    source_bytes="$(wc -c < "\${source_real}")" || exit 66
    case "\${source_bytes}" in *[!0-9]*) exit 66 ;; esac
    artifact_input_total=$((artifact_input_total + source_bytes))
    if [ "\${source_bytes}" -gt "\${SLURM_AGENT_MAX_INPUT_FILE_BYTES}" ] ||
       [ "\${artifact_input_total}" -gt "\${SLURM_AGENT_MAX_INPUT_TOTAL_BYTES}" ]; then
      echo "Artifact input exceeds the configured input limit: \${source_job_id}:\${source_relative}" >&2
      exit 66
    fi
    destination="\${SLURM_AGENT_INPUT_DIR}/\${destination_relative}"
    destination_parent="\${destination%/*}"
    /bin/mkdir -p -m 700 -- "\${destination_parent}"
    destination_parent_real="$(realpath -e -- "\${destination_parent}")" || exit 66
    case "\${destination_parent_real}/" in
      "\${input_root_real}/"*) ;;
      *) exit 66 ;;
    esac
    if [ -d "\${destination}" ] || [ -L "\${destination}" ]; then exit 66; fi
    temporary="\${destination}.slurm-agent-tmp.\${artifact_job_id}.$$"
    /bin/rm -f -- "\${temporary}"
    if ! /bin/cp -- "\${source_real}" "\${temporary}"; then
      /bin/rm -f -- "\${temporary}"
      exit 66
    fi
    copied_bytes="$(wc -c < "\${temporary}")" || exit 66
    if [ "\${copied_bytes}" != "\${source_bytes}" ]; then
      /bin/rm -f -- "\${temporary}"
      exit 66
    fi
    /bin/mv -f -- "\${temporary}" "\${destination}"
  done < "\${manifest_real}"
fi

case "\${SLURM_AGENT_LAUNCHER}:\${task_mode}" in
  single:0)
    ;;
  srun:0)
    : "\${SLURM_AGENT_SRUN_EXECUTABLE:?}"
    : "\${SLURM_AGENT_RUNNER:?}"
    : "\${SLURM_AGENT_NODES:?}"
    : "\${SLURM_AGENT_NTASKS:?}"
    : "\${SLURM_AGENT_CPUS_PER_TASK:?}"
    case "\${SLURM_AGENT_NODES}:\${SLURM_AGENT_NTASKS}:\${SLURM_AGENT_CPUS_PER_TASK}" in
      *[!0-9:]*) exit 64 ;;
    esac
    set -- "\${SLURM_AGENT_RUNNER}" "$@"
    if [ -n "\${SLURM_AGENT_GPUS_PER_TASK:-}" ]; then
      case "\${SLURM_AGENT_GPUS_PER_TASK}" in *[!0-9]*) exit 64 ;; esac
      set -- "--gpus-per-task=\${SLURM_AGENT_GPUS_PER_TASK}" "$@"
    fi
    if [ -n "\${SLURM_AGENT_NTASKS_PER_NODE:-}" ]; then
      case "\${SLURM_AGENT_NTASKS_PER_NODE}" in *[!0-9]*) exit 64 ;; esac
      set -- "--ntasks-per-node=\${SLURM_AGENT_NTASKS_PER_NODE}" "$@"
    fi
    if [ -n "\${SLURM_AGENT_DISTRIBUTION:-}" ]; then
      case "\${SLURM_AGENT_DISTRIBUTION}" in block|cyclic) ;; *) exit 64 ;; esac
      set -- "--distribution=\${SLURM_AGENT_DISTRIBUTION}" "$@"
    fi
    if [ -n "\${SLURM_AGENT_MPI_MODE:-}" ]; then
      case "\${SLURM_AGENT_MPI_MODE}" in *[!A-Za-z0-9_.-]*) exit 64 ;; esac
      set -- "--mpi=\${SLURM_AGENT_MPI_MODE}" "$@"
    fi
    set -- \
      "--export=ALL,SLURM_AGENT_TASK_MODE=1" \
      "--nodes=\${SLURM_AGENT_NODES}" \
      "--ntasks=\${SLURM_AGENT_NTASKS}" \
      "--cpus-per-task=\${SLURM_AGENT_CPUS_PER_TASK}" \
      "$@"
    unset SLURM_AGENT_TASK_MODE
    exec "\${SLURM_AGENT_SRUN_EXECUTABLE}" "$@"
    ;;
  srun:1)
    : "\${SLURM_PROCID:?}"
    case "\${SLURM_PROCID}" in *[!0-9]*) exit 64 ;; esac
    job_artifact_dir="\${job_artifact_dir}/ranks/\${SLURM_PROCID}"
    /bin/mkdir -p -m 700 "\${job_artifact_dir}"
    ;;
  *)
    exit 64
    ;;
esac

if [ -n "\${SLURM_AGENT_MODULES:-}" ]; then
  : "\${SLURM_AGENT_MODULECMD:?}"
  load_module_commands() {
    saved_ifs="\${IFS}"
    IFS=:
    set -- \${SLURM_AGENT_MODULES}
    IFS="\${saved_ifs}"
    "\${SLURM_AGENT_MODULECMD}" bash load "$@"
  }
  module_commands="$(load_module_commands)" || exit $?
  eval "\${module_commands}"
  unset module_commands
fi

case "\${SLURM_AGENT_RUNTIME_KIND}" in
  apptainer)
    : "\${SLURM_AGENT_APPTAINER_EXECUTABLE:?}"
    : "\${SLURM_AGENT_APPTAINER_IMAGE:?}"
    : "\${SLURM_AGENT_SUBMISSION_DIR:?}"
    : "\${SLURM_AGENT_WORKSPACE:?}"
    exec "\${SLURM_AGENT_APPTAINER_EXECUTABLE}" exec \
      --nv \
      --containall \
      --cleanenv \
      --bind "\${SLURM_AGENT_SUBMISSION_DIR}:/slurm-agent/submission:ro" \
      --bind "\${SLURM_AGENT_INPUT_DIR}:/inputs:ro" \
      --bind "\${SLURM_AGENT_WORKSPACE}:/workspace:ro" \
      --bind "\${job_artifact_dir}:/artifacts:rw" \
      --pwd /workspace \
      --env SLURM_AGENT_ARTIFACT_DIR=/artifacts \
      --env SLURM_AGENT_INPUT_DIR=/inputs \
      "\${SLURM_AGENT_APPTAINER_IMAGE}" \
      /slurm-agent/submission/payload "$@"
    ;;
  venv)
    : "\${SLURM_AGENT_VENV:?}"
    export VIRTUAL_ENV="\${SLURM_AGENT_VENV}"
    if [ -n "\${SLURM_AGENT_MODULES:-}" ]; then
      export PATH="\${SLURM_AGENT_VENV}/bin:\${PATH:-/usr/bin:/bin}"
    else
      export PATH="\${SLURM_AGENT_VENV}/bin:/usr/bin:/bin"
    fi
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
