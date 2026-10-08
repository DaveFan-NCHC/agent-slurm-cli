import type { NormalizedSubmit } from "../policy/validator.js";
import type { PreparedScript } from "../policy/script.js";
import type { CommandContext } from "./types.js";

export async function runSubmit(context: CommandContext, options: NormalizedSubmit, script: PreparedScript): Promise<Record<string, unknown>> {
  const resources = {
    partition: options.partition, nodes: options.nodes, ntasks: options.ntasks,
    ntasks_per_node: options.ntasksPerNode, cpus_per_task: options.cpusPerTask,
    memory: options.memory, memory_per_cpu: options.memoryPerCpu, time: options.time,
    gpus: options.gpus, gpus_per_node: options.gpusPerNode, gpus_per_task: options.gpusPerTask,
    gres: options.gres, exclusive: options.exclusive,
    account: options.account, qos: options.qos,
    constraint: options.constraint, nodelist: options.nodelist, exclude: options.exclude,
    reservation: options.reservation,
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
