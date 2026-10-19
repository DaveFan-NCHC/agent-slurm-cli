import type { Policy } from "../policy/types.js";
import type { CommandContext } from "./types.js";

function effectivePolicy(policy: Policy): Record<string, unknown> {
  return {
    allowed_partitions: policy.allowedPartitions,
    max_nodes: policy.maxNodes,
    max_ntasks: policy.maxNtasks,
    max_ntasks_per_node: policy.maxNtasksPerNode,
    max_cpus_per_task: policy.maxCpusPerTask,
    max_memory_gb: policy.maxMemoryGb,
    max_gpus: policy.maxGpus,
    max_gpus_per_node: policy.maxGpusPerNode,
    max_gpus_per_task: policy.maxGpusPerTask,
    allow_exclusive: policy.allowExclusive,
    max_time_minutes: policy.maxTimeMinutes,
    max_wait_seconds: policy.maxWaitSeconds,
    max_history_days: policy.maxHistoryDays,
    max_history_jobs: policy.maxHistoryJobs,
    max_list_jobs: policy.maxListJobs,
    max_input_files: policy.maxInputFiles,
    max_input_file_bytes: policy.maxInputFileBytes,
    max_input_total_bytes: policy.maxInputTotalBytes,
    max_array_tasks: policy.maxArrayTasks,
    max_array_concurrency: policy.maxArrayConcurrency,
    max_dependency_jobs: policy.maxDependencyJobs,
    allowed_dependency_types: policy.allowedDependencyTypes,
    allowed_launchers: policy.allowedLaunchers,
    allowed_mpi_modes: policy.allowedMpiModes,
    allowed_distributions: policy.allowedDistributions,
    max_log_lines: policy.maxLogLines,
    max_log_bytes: policy.maxLogBytes,
    max_artifact_bytes: policy.maxArtifactBytes,
    max_artifact_files: policy.maxArtifactFiles,
    allowed_signals: policy.allowedSignals,
    allowed_apptainer_images: policy.allowedApptainerImages,
    allowed_virtualenvs: policy.allowedVirtualenvs,
    allowed_modules: policy.allowedModules,
    allowed_gres: policy.allowedGres,
    allowed_accounts: policy.allowedAccounts,
    allowed_qos: policy.allowedQos,
    allowed_constraints: policy.allowedConstraints,
    allowed_nodelists: policy.allowedNodelists,
    allowed_exclude_nodelists: policy.allowedExcludeNodelists,
    allowed_reservations: policy.allowedReservations,
    max_script_bytes: policy.maxScriptBytes,
    max_script_args: policy.maxScriptArgs,
    max_script_arg_length: policy.maxScriptArgLength,
    require_apptainer_for_generated_scripts: policy.requireApptainerForGeneratedScripts,
  };
}

export function runPolicy(context: CommandContext, policy: Policy): Record<string, unknown> {
  context.audit.write({
    action: "policy",
    ssh_user: context.sshUser,
    policy_decision: "allowed",
    result: "success",
  });
  return { ok: true, policy: effectivePolicy(policy) };
}
