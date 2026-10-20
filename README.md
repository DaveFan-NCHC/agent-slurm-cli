# Slurm Agent CLI

`slurm-agent` is an independent, constrained CLI for operating a remote Slurm cluster over verified SSH. It is designed to be the capability boundary used by another agent through `exec`.

The public interface contains only these Slurm lifecycle operations:

```text
slurm-agent submit
slurm-agent policy
slurm-agent discover cluster|modules|associations|runtimes
slurm-agent cluster-info
slurm-agent modules
slurm-agent nodes
slurm-agent list
slurm-agent history
slurm-agent fairshare
slurm-agent status JOB_ID
slurm-agent diagnose JOB_ID
slurm-agent usage JOB_ID
slurm-agent cancel JOB_ID
slurm-agent hold JOB_ID
slurm-agent release JOB_ID
slurm-agent requeue JOB_ID
slurm-agent update JOB_ID
slurm-agent signal JOB_ID --signal NAME
slurm-agent logs JOB_ID
slurm-agent artifacts JOB_ID [--download [--prefix RELATIVE_DIRECTORY] [--force]]
slurm-agent artifact JOB_ID --path RELATIVE_PATH [--force]
slurm-agent wait JOB_ID
```

There is deliberately no `exec`, `ssh`, `shell`, arbitrary path, generic file-transfer, or generic remote-command operation. Successful and failed operational commands write one JSON object to stdout. Audit events go to stderr or a protected file.

The `discover` commands are bootstrap inventory operations for helping an operator configure policy. They require trusted SSH configuration but do not load `SLURM_POLICY_PATH` and do not filter results through operational allowlists. Slurm and the configured SSH identity still determine what the cluster exposes.

## Install

Node.js 20 or newer is required to build and run the package.

```bash
npm ci
npm run build
npm test
npm install -g .
slurm-agent --version
```

For production, publish and install a pinned version during image/host bootstrap:

```bash
npm install -g @nchc/slurm-agent@0.10.0
command -v slurm-agent
```

Do not give an agent runtime permission to run `npm`, `npx`, `node`, `ssh`, or a shell. The package may be used with `npx @nchc/slurm-agent ...` for development, but production should use the fixed installed executable.

## Configuration

Set these variables in the trusted runtime environment, not in agent-provided arguments:

```bash
export SLURM_SSH_HOST=login.cluster.example
export SLURM_SSH_PORT=22
export SLURM_SSH_USER=slurm-agent
export SLURM_SSH_KEY_PATH=/run/secrets/slurm-agent-key
export SLURM_SSH_KNOWN_HOSTS=/etc/slurm-agent/known_hosts
export SLURM_REMOTE_WORKSPACE=/home/slurm-agent/workspace
export SLURM_LOCAL_JOB_WORKSPACE=/var/lib/slurm-agent/jobs
export SLURM_LOCAL_ARTIFACTS=/var/lib/slurm-agent/artifacts
export SLURM_REMOTE_APPTAINER_PATH=/usr/bin/apptainer
export SLURM_REMOTE_SRUN_PATH=/usr/bin/srun
export SLURM_REMOTE_MODULECMD_PATH=/usr/bin/modulecmd
export SLURM_POLICY_PATH=/etc/slurm-agent/policy.yaml
export SLURM_AUDIT_LOG=/var/log/slurm-agent/audit.jsonl
```

By default, controlled uploads and downloads use the same SSH connection. If the cluster exposes a dedicated SFTP endpoint, configure it separately; the SFTP user and authentication method inherit from the SSH settings:

```bash
export SLURM_SFTP_HOST=transfer.cluster.example
export SLURM_SFTP_PORT=2222
export SLURM_SFTP_KNOWN_HOSTS=/etc/slurm-agent/known_hosts
```

`SLURM_SFTP_HOST` and `SLURM_SFTP_PORT` independently default to their `SLURM_SSH_*` counterparts once any `SLURM_SFTP_*` setting is present. `SLURM_SFTP_USER` can override the inherited SSH user. The command connection continues to execute the constrained Slurm commands, while submission uploads and artifact downloads use only the transfer connection.

For Nano4, use `nano4.nchc.org.tw:22` for `SLURM_SSH_*` and `nano4.nchc.org.tw:2222` for `SLURM_SFTP_*`. Both endpoints must expose the configured `/home` or `/work` path. The known-hosts file must contain entries for both `nano4.nchc.org.tw` and `[nano4.nchc.org.tw]:2222`.

### Supported SSH authentication scenarios

| Scenario | Expected server flow | Required authentication configuration |
|---|---|---|
| Private key | `publickey` | `SLURM_SSH_KEY_PATH` |
| Standard SSH password | `password` | `SLURM_SSH_PASSWORD`; leave `SLURM_SSH_PASSWORD_AUTH_METHOD` unset or set it to `password` |
| PAM password | One hidden password prompt through `keyboard-interactive` | `SLURM_SSH_PASSWORD` and `SLURM_SSH_PASSWORD_AUTH_METHOD=keyboard-interactive` |
| Private key plus automatic push | `publickey` partial success, followed by zero-prompt `keyboard-interactive` while the server waits for approval | `SLURM_SSH_KEY_PATH` and `SLURM_SSH_PUSH_AUTH=true` |
| Standard password plus automatic push | `password` partial success, followed by zero-prompt `keyboard-interactive` while the server waits for approval | `SLURM_SSH_PASSWORD` and `SLURM_SSH_PUSH_AUTH=true` |
| PAM password plus automatic push | One hidden password prompt, followed by an automatic push in the same PAM `keyboard-interactive` exchange | `SLURM_SSH_PASSWORD`, `SLURM_SSH_PASSWORD_AUTH_METHOD=keyboard-interactive`, and `SLURM_SSH_PUSH_AUTH=true` |

All scenarios still require `SLURM_SSH_KNOWN_HOSTS` or `SLURM_SSH_HOST_FINGERPRINT`. The CLI does not support prompts for dynamic OTP values, recovery codes, push-option selection, arbitrary multi-question challenges, or WebAuthn/FIDO interaction. A push flow must be initiated automatically by the server and completed out of band on the user's device.

Choose exactly one SSH authentication method. Private-key authentication uses `SLURM_SSH_KEY_PATH` as shown above. To use password authentication instead, omit that variable and set the password in the trusted runtime environment:

```bash
unset SLURM_SSH_KEY_PATH
export SLURM_SSH_PASSWORD='cluster-login-password'
```

If PAM exposes the password as a single hidden `keyboard-interactive` prompt instead of the SSH `password` method, select it explicitly. The CLI answers exactly one hidden prompt with `SLURM_SSH_PASSWORD`; additional, visible, or OTP prompts are rejected:

```bash
unset SLURM_SSH_KEY_PATH
export SLURM_SSH_PASSWORD='cluster-login-password'
export SLURM_SSH_PASSWORD_AUTH_METHOD=keyboard-interactive
```

For private-key or standard-password authentication followed by automatic out-of-band push approval, the server must report the first method as partially successful and then offer zero-prompt `keyboard-interactive`. Enable it with:

```bash
export SLURM_SSH_PUSH_AUTH=true
export SLURM_SSH_AUTH_TIMEOUT_MS=120000
```

The PAM password mode can also wait for an automatic push within the same keyboard-interactive exchange. In that case use both `SLURM_SSH_PASSWORD_AUTH_METHOD=keyboard-interactive` and `SLURM_SSH_PUSH_AUTH=true`; after receiving the password, the server must initiate the push without another prompt.

The authentication timeout defaults to 120 seconds in push mode and can be set from 1000 to 600000 milliseconds. The CLI waits on the same SSH connection until the user approves, denies, or the timeout expires. Every CLI invocation creates a new SSH connection and may therefore generate a new push request. Modes that ask the CLI to enter an OTP or select a push option are rejected.

Do not put the password in command-line arguments or agent-generated input. `SLURM_SSH_KNOWN_HOSTS` must contain a plain hostname entry (or `[host]:port` for a non-default port). Hashed hostnames are not parsed. As an alternative, set `SLURM_SSH_HOST_FINGERPRINT` to a pinned `SHA256:...` host-key fingerprint. One of these verification methods remains mandatory for either authentication method; insecure host-key checking is not available. A separate SFTP endpoint is checked against `SLURM_SFTP_KNOWN_HOSTS` (which defaults to the SSH known-hosts file) or `SLURM_SFTP_HOST_FINGERPRINT`. An SSH fingerprint is inherited only when SSH and SFTP use the same host and port.

Copy [examples/slurm-agent-policy.example.yaml](examples/slurm-agent-policy.example.yaml) to the protected `SLURM_POLICY_PATH` location and adjust its partition, resource limits, and optional aliases. Unknown policy keys fail closed.

Policy aliases map agent-visible logical names to operator-controlled runtime paths, GRES requests, or scheduler values:

```yaml
allowed_apptainer_images:
  pytorch: /opt/apptainer/pytorch.sif
allowed_virtualenvs:
  project-a: /home/agent/venvs/project-a
allowed_modules:
  gcc: gcc/12.2.0
  cuda: cuda/12.1
max_gpus: 4
max_ntasks_per_node: 8
max_gpus_per_node: 4
max_gpus_per_task: 1
allow_exclusive: false
allowed_gres:
  a100x1: gpu:a100:1
allowed_accounts:
  research: project-a
allowed_qos:
  standard: normal
allowed_constraints:
  modern-cpu: '[zen3|zen4]'
  zen4-only: zen4
allowed_nodelists:
  gpu-a: 'gpu[01-02]'
allowed_exclude_nodelists:
  maintenance: 'gpu[03,07-09]'
allowed_reservations:
  workshop: workshop2026
max_wait_seconds: 86400
max_history_days: 30
max_history_jobs: 200
max_list_jobs: 200
max_input_files: 64
max_input_file_bytes: 104857600
max_input_total_bytes: 536870912
max_array_tasks: 1000
max_array_concurrency: 32
max_dependency_jobs: 16
allowed_dependency_types: [after, afterany, aftercorr, afternotok, afterok, singleton]
allowed_launchers: [single, srun]
allowed_mpi_modes: [pmix]
allowed_distributions: [block, cyclic]
max_artifact_files: 1000
allowed_signals: [TERM, USR1, USR2]
max_script_bytes: 65536
max_script_args: 32
max_script_arg_length: 1024
require_apptainer_for_generated_scripts: true
```

Input bundles, arrays, dependencies, `srun`, MPI modes, rank placement, per-node/per-task GPUs, exclusive nodes, and signals are opt-in for upgrades. Input limits default to zero, advanced launcher allowlists default to empty, and `allowed_launchers` defaults to `[single]`, preserving one payload execution per job. Set bounded values explicitly to enable only the capabilities wanted by the operator.

Aliases are accepted from the CLI; raw image, virtualenv, module, GRES, account, QOS, constraint, included/excluded node-list, and reservation values are not. `max_gpus: 0` disables direct `--gpus` requests. Omitting one of the scheduler alias mappings disables that submit option.

### Cluster path visibility

`slurm-agent` submits from the login node, but the trusted runner and payload execute on a compute node. Configure remote paths with the following visibility:

| Path | Required visibility | Reason |
|---|---|---|
| `SLURM_REMOTE_WORKSPACE` | Must be a shared filesystem mounted at the same absolute path on the login node and every eligible compute node | It contains `.slurm-agent/submissions`, logs, and artifacts. Compute nodes read the staged payload and write logs/artifacts; the login node later reads or downloads them. |
| `allowed_apptainer_images.*` | Must resolve to the same image at the same absolute path on the login node and every eligible compute node | The login node validates the image, while the compute node executes it with NVIDIA GPU support (`--nv`). A shared filesystem is recommended; an identically replicated image also works. |
| `allowed_virtualenvs.*` | Must resolve to the same environment at the same absolute path on the login node and every eligible compute node | The login node validates `bin/python`, while the compute node runs the environment. A shared filesystem is recommended; an identical installation on every node also works. |
| `SLURM_REMOTE_APPTAINER_PATH` | Must be executable at the same absolute path on the login node and every eligible compute node | It may be installed locally on each node and does not itself need to be on shared storage. |
| `SLURM_REMOTE_SRUN_PATH` | Must be executable at the same absolute path on the login node and every eligible compute node when `srun` is enabled | The trusted runner invokes this operator-configured executable; callers cannot choose its path or flags. |
| `SLURM_REMOTE_MODULECMD_PATH` | Must be executable at the same absolute path on the login node and every eligible compute node when modules are selected | The trusted runner evaluates environment changes emitted by this operator-controlled Environment Modules/Lmod executable. Modulefiles reachable through approved aliases are part of the trusted cluster configuration. |

Typical shared filesystems include NFS, Lustre, GPFS, and BeeGFS. A directory local only to the login node, such as its private `/tmp`, is not suitable for `SLURM_REMOTE_WORKSPACE` or a non-replicated runtime alias. The CLI can validate remote paths only on the login node before submission, so a missing compute-node mount may not be detected until the job starts.

These paths belong only to the machine running the CLI and do **not** need to be visible on Slurm nodes: `SLURM_LOCAL_JOB_WORKSPACE`, `SLURM_LOCAL_ARTIFACTS`, `SLURM_SSH_KEY_PATH`, `SLURM_SSH_KNOWN_HOSTS`, `SLURM_SFTP_KNOWN_HOSTS`, `SLURM_POLICY_PATH`, and `SLURM_AUDIT_LOG`. `SLURM_SSH_PASSWORD`, when used, likewise belongs only in the trusted CLI runtime environment.

The configured SSH account should also be restricted at the cluster and filesystem layers. The CLI boundary complements, but does not replace, least-privilege Unix and Slurm configuration.

## Usage

### Bootstrap discovery

Inspect the environment before creating or revising policy:

```bash
slurm-agent discover cluster
slurm-agent discover modules
slurm-agent discover associations
slurm-agent discover runtimes
```

`cluster` returns all Slurm-visible partition summaries and a compact node inventory: node name, partition, state, total CPUs, total memory, configured GRES, and available features. Transient allocation, free-memory, GRES-usage, and drain-reason fields are intentionally excluded; use the policy-scoped `nodes` command for those operational details. `modules` invokes the configured Environment Modules/Lmod executable in terse mode and returns the live module catalog. `associations` reports the configured user's Slurm accounts, partitions, QOS values, and visible reservations; unavailable optional accounting data is returned as a warning. `runtimes` checks the configured Apptainer, srun, and modulecmd paths. Discovery is bounded and structured but is intentionally independent of policy. The Agent can use this inventory and the user's requirements to propose policy; the CLI does not generate or modify policy automatically.

Agent-generated scripts are read from `SLURM_LOCAL_JOB_WORKSPACE`, uploaded to a CLI-generated staging directory below `SLURM_REMOTE_WORKSPACE`, and submitted through a trusted runner. The interface follows the safe subset of `sbatch`:

```bash
slurm-agent submit \
  -p slurm-test \
  -N 1 \
  -n 4 \
  -c 2 \
  --mem 8G \
  --gpus 1 \
  -t 01:00:00 \
  -J naca \
  --apptainer-image pytorch \
  jobs/naca.sh --mesh fine
```

```json
{"ok":true,"job_id":"12345","launcher":{"mode":"single"}}
```

Stage bounded files from `SLURM_LOCAL_JOB_WORKSPACE` with repeatable `--input` options placed before the script path:

```bash
slurm-agent submit -p slurm-test \
  --input config/run.yaml \
  --input src/model.py \
  --apptainer-image pytorch \
  jobs/train.sh
```

Inputs keep their safe workspace-relative paths below a generated submission `inputs/` directory. The payload reads its input root from `SLURM_AGENT_INPUT_DIR`; Apptainer sees it as read-only `/inputs`. Host and virtualenv runtimes receive the job-specific remote directory, but those modes are not sandboxes: because the payload runs as the same Unix identity, it can modify staged files. Arrays share one staged input bundle. The response and audit event contain only file count, total bytes, and a deterministic manifest SHA-256, not file contents. A failed upload never reaches `sbatch`; an incomplete random staging directory is unusable and may later be removed by the operator's retention policy.

Reuse an owned upstream job artifact without exposing the remote workspace layout by combining a dependency with a repeatable artifact input reference:

```bash
slurm-agent submit -p slurm-test \
  --dependency afterok:12345 \
  --artifact-input 12345:results/model.bin:models/model.bin \
  --apptainer-image pytorch jobs/evaluate.sh
```

The format is `JOB_ID:SOURCE_PATH[:DESTINATION_PATH]`. When the destination is omitted it defaults to the source path. The downstream payload reads the copied file below its normal input root, for example `"$SLURM_AGENT_INPUT_DIR/models/model.bin"`; it never needs `/workspace` or `.slurm-agent` paths. Use an explicit array task ID such as `12345_7` to consume one array task's artifacts.

Artifact inputs are ownership-checked at submission and copied only when the downstream job starts, so an `afterok` pipeline can be submitted while the producer is still running. Dependencies are not added implicitly: use `afterok` when successful producer completion is required. Source and destination paths must be safe relative paths, symlink sources are rejected, destination collisions are rejected, and local plus artifact inputs share `max_input_files`, `max_input_file_bytes`, and `max_input_total_bytes`. Runtime staging failure causes the downstream job to fail before its payload starts.

Choose at most one runtime alias per submission:

```bash
slurm-agent submit -p slurm-test --apptainer-image pytorch jobs/train.sh
slurm-agent submit -p slurm-test --venv project-a jobs/train.sh
```

List operator-approved environment modules and select one or more aliases in load order:

```bash
slurm-agent modules
slurm-agent submit -p slurm-test --module gcc --module cuda jobs/build.sh
```

`modules` reports only `allowed_modules` aliases, not the cluster's unrestricted module tree. `--module` is repeatable, rejects unknown or duplicate aliases, and is supported for host and virtualenv jobs. It cannot be combined with `--apptainer-image`; put required software inside the approved image instead. At job start the trusted runner invokes the configured `modulecmd` and applies its emitted environment changes before executing the payload.

MPI jobs can bound rank placement and memory per allocated CPU. `--mem` and `--mem-per-cpu` are mutually exclusive; the latter is checked against `max_memory_gb` using `ntasks × cpus-per-task`:

```bash
slurm-agent submit -p slurm-test -N 2 -n 8 --ntasks-per-node 4 \
  -c 2 --mem-per-cpu 2G --launcher srun --mpi pmix \
  --distribution block jobs/mpi.sh
```

`--launcher single` is the backward-compatible default and executes the payload once even when `--ntasks` is greater than one. `--launcher srun` starts a job step with the validated node/task/CPU placement and optional per-task GPU count. The caller cannot supply raw `srun` flags: MPI modes and `block|cyclic` distributions must be operator-approved. The host `srun` starts each rank and each rank then enters the selected host, virtualenv, or Apptainer runtime. Apptainer MPI still requires the operator to validate the image's PMI/PMIx ABI and cluster integration.

For `srun`, each rank receives a distinct artifact directory below `ranks/$SLURM_PROCID`; this prevents ranks from overwriting the same artifact name. `exec srun` preserves Slurm's aggregate exit status and normal signal/cancellation behavior. Rank output shares the job's Slurm stdout/stderr and may interleave.

GPU resources can be requested by a policy-bounded total, per-node count, per-task count, or operator-defined GRES alias. Choose exactly one form:

```bash
slurm-agent submit -p slurm-test --gpus 1 --apptainer-image pytorch jobs/train.sh
slurm-agent submit -p slurm-test -N 2 --gpus-per-node 2 jobs/train.sh
slurm-agent submit -p slurm-test -n 4 --gpus-per-task 1 jobs/train.sh
slurm-agent submit -p slurm-test --gres a100x1 --apptainer-image pytorch jobs/train.sh
```

Per-node and per-task requests are checked both against their own policy caps and the total `max_gpus`. `--exclusive` is accepted only when `allow_exclusive: true`; combine it with bounded per-node `--mem`, not `--mem-per-cpu`, because Slurm may allocate memory for every usable CPU on an exclusive node.

Select operator-approved account, QOS, node constraints, included/excluded node lists, or reservations with policy aliases:

```bash
slurm-agent submit -p slurm-test \
  --account research --qos standard \
  --constraint modern-cpu --nodelist gpu-a --exclude maintenance \
  --reservation workshop \
  --apptainer-image pytorch jobs/train.sh
```

`--nodelist` (short form `-w`) maps an alias through `allowed_nodelists` before passing the resulting hostlist to `sbatch`. For example, `gpu-a: 'gpu[01-02]'` permits that controlled hostlist while rejecting raw node names and unknown aliases.

`--exclude` (short form `-x`) similarly maps an alias through `allowed_exclude_nodelists` before passing the controlled exclusion hostlist to `sbatch`.

`--gres` never accepts a raw Slurm GRES expression. The CLI maps the alias through `allowed_gres` before constructing `sbatch`.

Submit a job array with Slurm indexes, ranges, optional steps, and a concurrency cap:

```bash
slurm-agent submit -p slurm-test --array '0-99%10' jobs/process.sh
slurm-agent submit -p slurm-test --array '1,3,5-15:2%4' jobs/process.sh
```

Each array task receives `SLURM_ARRAY_TASK_ID`. The expanded task count must not exceed `max_array_tasks`; its explicit or implied concurrency must not exceed `max_array_concurrency`. Therefore an array larger than the concurrency policy must include a `%CONCURRENCY` cap. The JSON response includes the normalized task count and concurrency. Use task IDs such as `12345_7` with per-task `status`, `usage`, `wait`, `logs`, `artifact`, or `cancel`; cancelling the parent `12345` cancels the owned whole array.

Submit a job after policy-approved conditions on owned jobs:

```bash
slurm-agent submit -p slurm-test --dependency afterok:12345 jobs/train.sh
slurm-agent submit -p slurm-test --dependency afterok:12345:12346,afternotok:12347 jobs/finalize.sh
```

Dependency clauses are combined with AND. OR (`?`), offsets, arbitrary expressions, cross-user references, disallowed types, and more than `max_dependency_jobs` references are rejected. `allowed_dependency_types` controls the accepted subset of `after`, `afterany`, `aftercorr`, `afternotok`, `afterok`, and `singleton`. `aftercorr` requires the new submission to be an array; `singleton` requires an explicit `--job-name` so its serialization scope is deliberate.

With the default secure policy, agent-generated scripts require an approved Apptainer alias. The CLI-generated runner forces execution through `--containall` and `--cleanenv`, mounts the remote workspace and staged inputs read-only, and mounts only that job's controlled artifact directory read-write. The agent script does not invoke Apptainer itself:

```bash
#!/bin/sh
set -eu
python train.py "$@"
```

The script must be valid UTF-8, begin with a shebang, fit the policy size limit, and contain no `#SBATCH` directives. Scheduler resources must be expressed through CLI options. Virtualenv-only or direct host execution is not a security sandbox and is available only when an operator sets `require_apptainer_for_generated_scripts: false`.

Other operations:

```bash
slurm-agent policy
slurm-agent cluster-info
slurm-agent nodes --partition slurm-test --state idle
slurm-agent nodes --feature zen4-only
slurm-agent list --state PENDING,RUNNING --partition slurm-test --limit 50
slurm-agent list --name train --account research --sort priority_desc --array-view expanded
slurm-agent history --days 7 --state COMPLETED,FAILED --limit 50
slurm-agent history --since 2026-10-01T00:00:00 --until 2026-10-08T00:00:00 \
  --partition slurm-test --name train --account research --sort end_time_desc
slurm-agent fairshare
slurm-agent status 12345
slurm-agent diagnose 12345
slurm-agent usage 12345
slurm-agent wait 12345 --timeout 3600 --poll-interval 10
slurm-agent logs 12345 --stream stdout --tail 200
slurm-agent artifact 12345 --path results/model.bin
slurm-agent cancel 12345
slurm-agent hold 12345
slurm-agent release 12345
slurm-agent requeue 12345
slurm-agent update 12345 --time 02:00:00 --array-concurrency 8
slurm-agent update 12345 --dependency afterok:12344
slurm-agent signal 12345 --signal USR1 --scope batch
slurm-agent artifacts 12345
slurm-agent artifacts 12345 --download
slurm-agent artifacts 12345 --download --prefix airfoil_unsteady/VTK
slurm-agent artifact 12345 --path results/model.bin --force
```

`policy` returns the validated effective policy, including loader defaults, as JSON. It is read-only: the CLI does not provide a policy mutation interface. `cluster-info` returns partition-level availability, time limit, node state, CPU counts, and configured GRES only for `allowed_partitions`. `nodes` returns node state, CPU state, total/allocated/free memory, configured/used GRES, available/active features, temporary disk, and unavailable reason fields. `free_mib` is an informational OS report and is not scheduler-available memory. Node queries may be narrowed by an allowed partition, a supported node state, or a policy constraint alias that resolves to one concrete feature.

`list` remains fixed to the configured SSH user and supports bounded state, allowed partition, safe exact job name, account alias, sort, limit, and expanded/summary array views. `max_list_jobs` caps the result count. `history` adds the same partition/name/account filtering, comma-separated states, sorting, array views, and either bounded `--days` or an explicit `--since`/`--until` pair. Explicit timestamps use `YYYY-MM-DDTHH:MM:SS` in the Slurm cluster's local time. `--days` and explicit timestamps are mutually exclusive.

Active `list` and `status` results include available scheduling diagnostics such as pending reason, priority, actual or expected start time, submit time, time limit/remaining, allocated nodes, CPU/node counts, account, QOS, and reservation. For a pending job, `start_time` is Slurm's estimate and may be unavailable when the cluster does not use backfill scheduling. Completed `status` records return the corresponding retained accounting fields.

`diagnose JOB_ID` verifies ownership, combines bounded `squeue`/`sacct`, `scontrol show job`, and (for pending jobs) `sprio` queries, and returns requested resources, eligible/dependency fields, stable finding codes, and multifactor priority components. If `sprio` is unavailable or the cluster does not use multifactor priority, diagnosis still succeeds with `priority.available: false`. Findings classify only data reported by Slurm and do not claim an exact start time.

`hold`, `release`, and `requeue` verify ownership before invoking the matching `scontrol` operation. A parent array ID applies to the whole owned array; an explicit task ID applies only to that task. `release` cannot remove an administrator hold. `requeue` restarts the batch script from the beginning with the same job ID.

`update` exposes only time limit, dependency, and array concurrency changes. It applies the same policy bounds as submission, verifies the target job and every referenced dependency job are owned by the configured user, and does not expose generic `scontrol update` fields.

`signal` verifies ownership and accepts only names in `allowed_signals`. Scope `steps` is the default, `batch` signals only the batch step, and `full` includes the batch script and child processes. Destructive uncatchable signals such as `KILL` and `STOP` cannot be placed in the policy allowlist.

`fairshare` returns the configured user's `sshare` values, including account, shares, usage, fair-share factors, and TRES minutes. It requires Slurm accounting/fair-share data to be available and rejects unexpected rows for another user.

`wait` polls the owned job until it reaches a terminal state. If its bounded timeout expires, it returns `ok: true`, `terminal: false`, `timed_out: true`, and the last observed job state. `terminal: true` means the job has stopped, not necessarily that it succeeded; callers must inspect `job.state` and `job.exit_code`.

`history` uses one bounded accounting query and returns allocation records only for the configured SSH user. Time windows and result counts are capped by `max_history_days` and `max_history_jobs`; `--state` accepts one to eight supported Slurm job states.

`usage` verifies ownership and returns allocation/step accounting including CPU time, peak RSS/VM size, disk I/O, requested and allocated TRES, and exit status. CPU efficiency is `TotalCPU / (ElapsedRaw × AllocCPUS)`. Memory efficiency compares the largest reported step `MaxRSS` with the requested memory after applying Slurm's per-CPU (`c`) or per-node (`n`) scope; it is an estimate for multi-task jobs. An efficiency field is omitted when its inputs are unavailable. For non-pending active jobs, `live_steps` comes from `sstat`; `live_available: false` means live metrics were unavailable, while accounting data remains valid.

Submissions always set output files under `.slurm-agent/logs` in the real remote workspace. Regular jobs use `%j.out`/`%j.err`; arrays use `%A_%a.out`/`%A_%a.err`, matching task IDs such as `12345_7`. `logs` can read only those generated names, limits lines and bytes, and verifies the resolved path is still inside the workspace. Consequently, `logs` does not read arbitrary output paths from jobs submitted outside this CLI.

### Job artifacts

`submit` supplies the job-specific `SLURM_AGENT_ARTIFACT_DIR` to the payload. A job places downloadable files directly below it:

```bash
artifact_dir="$SLURM_AGENT_ARTIFACT_DIR"
mkdir -p "$artifact_dir/results"
cp model.bin "$artifact_dir/results/model.bin"
```

The controlled download command is:

```bash
slurm-agent artifacts 12345
slurm-agent artifact 12345 --path results/model.bin
slurm-agent artifacts 12345 --download
slurm-agent artifacts 12345 --download --prefix airfoil_unsteady/VTK
```

`artifacts` first verifies ownership and containment, then lists only regular files below the job's artifact directory as `{path, bytes}` records. It does not follow symlinks, cross filesystems, or expose a generic filesystem browser; the count is bounded by `max_artifact_files` and a fixed output-size limit.

`artifact` verifies job ownership and both remote and local path containment, enforces `max_artifact_bytes`, and refuses to overwrite an existing local file by default. The resulting file is stored at `SLURM_LOCAL_ARTIFACTS/12345/results/model.bin`; callers cannot provide an arbitrary local output path. An explicit `--force` may atomically replace an existing regular file, including a zero-byte failed download, but never a directory, symlink, or special file. The old file remains intact unless the new download completes and passes checksum verification.

With `--download`, `artifacts` creates a capped temporary `tar.gz` under the controlled remote workspace, downloads it through the configured SFTP transfer connection, and removes the remote file in a `finally` cleanup. A separately configured SFTP endpoint is therefore used automatically and must expose the same remote workspace path. The bundle contains all safe regular-file paths and is not constrained by the artifact-list count or 1 MiB metadata limit. Its compressed size is bounded by `max_artifact_bytes`; creation and transfer are individually bounded by the configured command timeout. It does not cross filesystems or follow symlinks.

`--prefix RELATIVE_DIRECTORY` restricts a bundle to one real subdirectory below the owned job's artifact root while preserving that prefix inside the archive. It is valid only with `--download`; traversal, absolute paths, and directories reached through symlinks are rejected. A prefix bundle receives a deterministic collision-resistant local name such as `artifacts-VTK-a1b2c3d4.tar.gz`, reported in `bundle.local_path`. Whole-job bundles continue to use `artifacts.tar.gz`. `--force` has the same verified atomic replacement behavior for either bundle name.

Every single-file and bundle download calculates SHA-256 remotely, calculates it again while receiving bytes over SFTP, and installs the local file only when both values match. A mismatch returns `ARTIFACT_CHECKSUM_MISMATCH`, removes the incomplete local file, and preserves any previous destination.

```json
{"ok":true,"artifact":{"job_id":"12345","remote_path":"/home/slurm-agent/workspace/.slurm-agent/artifacts/12345/results/model.bin","local_path":"/var/lib/slurm-agent/artifacts/12345/results/model.bin","bytes":1048576,"sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","overwritten":false}}
```

```json
{"ok":true,"bundle":{"job_id":"12345","format":"tar.gz","prefix":"airfoil_unsteady/VTK","local_path":"/var/lib/slurm-agent/artifacts/12345/artifacts-VTK-a1b2c3d4.tar.gz","bytes":2097152,"sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","overwritten":false}}
```

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | success |
| 1 | configuration or general failure |
| 2 | invalid arguments |
| 3 | policy/path denial |
| 4 | SSH, host verification, or timeout failure |
| 5 | Slurm operation failure |
| 6 | job/log not found |
| 7 | job ownership denied |

Errors retain a stable machine-readable code, for example:

```json
{"ok":false,"error":{"code":"PARTITION_NOT_ALLOWED","message":"Partition gpu is not permitted."}}
```

If a remote Slurm command fails, the error object also includes a sanitized `slurm_message` from remote stderr when one is available. It is limited to 4096 UTF-8 bytes; `slurm_message_truncated: true` indicates that additional output was omitted. Raw Slurm stderr is not written to the audit log.

## Security model and limitations

- Remote operations use a compile-time executable allowlist and separately shell-quoted arguments. `artifacts --download` uses one compile-time fixed Bash pipeline to create a capped temporary archive; callers cannot provide shell fragments, archive arguments, or temporary paths.
- Job IDs, array specifications, dependencies, partition names, script segments, job names, resource units, and times use strict grammars. Unknown flags and duplicate non-repeatable flags are rejected; repeated inputs must resolve to unique destinations.
- Runtime and scheduler selection accepts only policy-defined logical aliases. Apptainer images must resolve to regular files; virtual environments must contain an executable `bin/python`. Raw runtime paths, account/QOS/constraint/reservation values, image URIs, bind mounts, and caller-provided commands are unavailable.
- Agent scripts come only from `SLURM_LOCAL_JOB_WORKSPACE`; symlinks, traversal, oversized files, invalid UTF-8, missing shebangs, and embedded `#SBATCH` directives are rejected. The exact bytes are hashed before upload.
- Submission inputs also come only from `SLURM_LOCAL_JOB_WORKSPACE`; absolute/traversal paths, symlinks in any path component, hard links, special files, duplicates, and policy limit violations are rejected. Input bytes are read and hashed before any remote operation.
- Upload destinations are random, CLI-generated directories below `.slurm-agent/submissions`; callers cannot select a remote destination. Payload, input, manifest, and trusted runner uploads use temporary files followed by atomic rename. `sbatch` runs only after every required upload succeeds.
- `single` remains the default launcher. `srun` uses only the operator-configured executable and validated task placement, MPI, and distribution fields; no raw launcher arguments are exposed.
- The batch environment exports only controlled `SLURM_AGENT_*` values, not the complete SSH process environment.
- `cancel`, `hold`, `release`, `requeue`, `update`, `signal`, `status`, `diagnose`, `usage`, `wait`, `logs`, `artifacts`, and `artifact` confirm that Slurm reports the configured user as owner. Dependency references receive the same ownership check before submission or update. `list`, `history`, and `fairshare` fix their queries to that user and reject unexpected cross-user rows.
- Script and log paths are checked with remote `realpath`, preventing traversal and symlink escape.
- Artifact transfer uses the configured SFTP connection for both single files and bundles after remote containment checks; it is not an SFTP browser. Bundle creation, checksum calculation, and cleanup stay on the command connection. Remote and local SHA-256 values must match before an atomic local install. Local destinations are created without overwrite unless the caller explicitly supplies `--force`, which can replace only a regular file after successful verification.
- Audit records never contain private keys, credentials, command stderr, or environment values.
- The remote host needs Bash, GNU-compatible `realpath`, `test`, `mkdir`, `rm`, `cp`, `mv`, `head`, `wc`, `tail`, `find`, `tar`, and `sha256sum`, plus `sbatch`, `squeue`, `sacct`, `scancel`, `scontrol`, `sinfo`, `sprio`, `sshare`, and `sstat` in its non-interactive PATH. `srun` is additionally required at `SLURM_REMOTE_SRUN_PATH` when that launcher is enabled. `sprio` may return no factors on clusters without multifactor priority; this is a supported diagnose degradation.
- Cluster-wide enforcement still belongs in Slurm configuration such as account/QOS limits and `job_submit` policy; the CLI policy is an additional capability boundary, not a replacement for scheduler controls.
- Completed-job lookup depends on Slurm accounting (`sacct`) retention and permissions. If no allocation record is visible, the CLI reports `JOB_NOT_FOUND`.
- Live resource metrics depend on Slurm's `jobacct_gather` support. If `sstat` is unavailable for a running job, `usage` returns accounting data with `live_available: false`.
- SSH certificates, encrypted private keys requiring an interactive passphrase, wildcard/hashed `known_hosts` entries, dependency OR/offset expressions, and federation IDs are not supported.
- Submitted staging directories are retained for reproducibility in this release; production deployments should apply an operator-controlled retention policy.

## Development

```bash
npm run typecheck
npm test
npm run build
```

## GitLab CI

[`.gitlab-ci.yml`](.gitlab-ci.yml) runs for branches, tags, and merge requests. Type checking and tests run in parallel on Node.js 22; the package job starts only after both pass and retains `dist/` plus the npm tarball for seven days.

Tests cover traversal, absolute paths, remote/local symlink escape, shell metacharacters/control characters, unexpected commands, Slurm argument injection, resource limits, partition denial, ownership denial, fixed log/artifact paths, parsers, and output construction. Integration tests use a typed mock transport and do not require a live cluster.
