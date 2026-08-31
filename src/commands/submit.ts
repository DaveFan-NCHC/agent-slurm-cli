import type { NormalizedSubmit } from "../policy/validator.js";
import type { PreparedScript } from "../policy/script.js";
import type { CommandContext } from "./types.js";

export async function runSubmit(context: CommandContext, options: NormalizedSubmit, script: PreparedScript): Promise<Record<string, unknown>> {
  const resources = {
    partition: options.partition, nodes: options.nodes, ntasks: options.ntasks,
    cpus_per_task: options.cpusPerTask, memory: options.memory, time: options.time,
    gpus: options.gpus, gres: options.gres,
    array: options.array, array_tasks: options.arrayTaskCount, array_concurrency: options.arrayConcurrency,
    dependency: options.dependency, dependency_jobs: options.dependencyJobIds,
    apptainer_image: options.apptainerImage, venv: options.venv,
    script_sha256: script.sha256,
  };
  const jobId = await context.client.submit(options, script);
  context.audit.write({ action: "submit", ssh_user: context.sshUser, job_id: jobId, resources, policy_decision: "allowed", result: "success", remote_exit_code: 0 });
  return {
    ok: true, job_id: jobId,
    ...(options.array ? {
      array: { spec: options.array, task_count: options.arrayTaskCount, concurrency: options.arrayConcurrency },
    } : {}),
    ...(options.dependency ? { dependency: options.dependency } : {}),
  };
}
