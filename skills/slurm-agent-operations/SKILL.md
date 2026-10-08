---
name: slurm-agent-operations
description: "Operate jobs through the constrained slurm-agent CLI, including MPI/GPU resource placement, arrays and dependencies, filtered queue/history and node-resource inspection, pending-job diagnosis, fair-share inspection, safe job updates and signals, lifecycle controls, logs, and controlled artifact listing/downloads. Use for Slurm job lifecycle requests handled by this project; do not use it for cluster administration or generic SSH access."
---

# Slurm Agent Operations

Use the installed `slurm-agent` executable as the only interface to the remote Slurm cluster.

## Boundaries

- Invoke only `submit`, `cluster-info`, `nodes`, `list`, `history`, `fairshare`, `status`, `diagnose`, `usage`, `wait`, `logs`, `cancel`, `hold`, `release`, `requeue`, `update`, `signal`, `artifacts`, or `artifact`.
- Never invoke or propose `ssh`, `exec`, `shell`, `run`, `scp`, `sftp`, arbitrary remote commands, or arbitrary remote/local paths.
- Treat stdout as the machine-readable JSON response. Audit records may appear on stderr and must not be mixed into JSON parsing.
- Do not expose SSH keys, credentials, or trusted `SLURM_*` environment values.
- Use the installed, pinned executable in production. Do not use `npm`, `npx`, or `node` at agent runtime.
- Do not bypass a policy denial by changing partitions, resources, paths, or command forms unless the user supplies an authorized alternative.

## Preflight

When installation availability is uncertain, run:

```bash
slurm-agent --version
```

Operational commands require trusted runtime configuration. Operators configure these outside agent-controlled arguments:

```text
SLURM_SSH_HOST
SLURM_SSH_PORT
SLURM_SSH_USER
SLURM_SSH_KEY_PATH
SLURM_SSH_KNOWN_HOSTS or SLURM_SSH_HOST_FINGERPRINT
optional SLURM_SFTP_HOST, SLURM_SFTP_PORT, and SLURM_SFTP_USER for a dedicated transfer endpoint
SLURM_SFTP_KNOWN_HOSTS or SLURM_SFTP_HOST_FINGERPRINT when the transfer endpoint needs separate host verification
SLURM_REMOTE_WORKSPACE
SLURM_LOCAL_JOB_WORKSPACE   contains Agent-generated scripts
SLURM_POLICY_PATH
SLURM_LOCAL_ARTIFACTS     required for artifact downloads
SLURM_AUDIT_LOG           optional; otherwise audit goes to stderr
```

Do not read or print credential files during ordinary operation. If configuration is missing, report the named missing setting without inventing a value.

### Remote path visibility

`SLURM_REMOTE_WORKSPACE` must be a shared filesystem mounted at the same absolute path on the login node and all eligible compute nodes. Its `.slurm-agent/submissions`, logs, and artifacts are consumed on both sides.

Policy-mapped Apptainer images and virtual environments must also be available with the same content at the same absolute path on the login and compute nodes. Shared storage is preferred, although identical per-node copies work. `SLURM_REMOTE_APPTAINER_PATH` may be node-local, but the executable must exist at that same path on every relevant node.

The CLI validates these paths only on the login node. If submission succeeds but the runner, image, virtual environment, log, or artifact path is missing when the job starts, report a likely compute-node mount/path mismatch to the operator; do not bypass the policy with another raw path.

Local CLI paths—including `SLURM_LOCAL_JOB_WORKSPACE`, `SLURM_LOCAL_ARTIFACTS`, SSH key/known-hosts files, policy, and audit log—do not need to be mounted on Slurm nodes.

## Job lifecycle

### Submit

The Agent may create a script below `SLURM_LOCAL_JOB_WORKSPACE`; pass its safe relative POSIX path as the first positional argument. The CLI validates and hashes it, then uploads it to a generated remote staging path. Do not use `..`, an absolute path, a symlink, or unexpected Slurm flags. Scripts must begin with a shebang and may not contain `#SBATCH` directives.

```bash
slurm-agent submit \
  -p <allowed-partition> \
  -N 1 \
  -n 4 \
  -c 2 \
  --mem 8G \
  -t 01:00:00 \
  -J example \
  --apptainer-image pytorch \
  jobs/example.sh --epochs 20
```

Defaults are one node, one task, one CPU per task, `1G`, and `01:00:00`. Resource values and the partition must remain within the configured policy. Record the returned `job_id`; use that ID, or an explicit array task ID such as `12345_7`, in later commands.

Submit an array only with bounded indexes and explicit concurrency when policy requires it:

```bash
slurm-agent submit ... --array '0-99%10'
```

The task count and concurrency must fit `max_array_tasks` and `max_array_concurrency`. Each task receives `SLURM_ARRAY_TASK_ID`. Use `12345_7` for per-task status, usage, wait, logs, artifact, or cancellation. Cancelling the parent ID cancels the entire owned array, so do that only when the user explicitly requests the whole array.

Submit dependencies only with policy-approved AND conditions on owned jobs:

```bash
slurm-agent submit ... --dependency afterok:12345
slurm-agent submit ... --dependency afterok:12345:12346,afternotok:12347
```

Do not invent or broaden dependency references. OR conditions, offsets, cross-user jobs, disallowed types, and reference counts above policy are unavailable. Use `aftercorr` only for a new array submission, and use `singleton` only with an explicit `--job-name`.

Use only policy-defined aliases for scheduler-specific account, QOS, node constraint, included/excluded node-list, and reservation selection:

```bash
slurm-agent submit ... --account research --qos standard --constraint modern-cpu --nodelist gpu-a --exclude maintenance --reservation workshop
```

Never pass raw scheduler values; the CLI resolves aliases through `allowed_accounts`, `allowed_qos`, `allowed_constraints`, `allowed_nodelists`, `allowed_exclude_nodelists`, and `allowed_reservations`.

Request GPUs with at most one of these policy-controlled forms:

```bash
slurm-agent submit ... --gpus 1
slurm-agent submit ... --gpus-per-node 2
slurm-agent submit ... --gpus-per-task 1
slurm-agent submit ... --gres a100x1
```

The GPU forms are mutually exclusive. Per-node and per-task requests are bounded by their corresponding policy limits and by total `max_gpus`. `--gres` is an agent-visible alias resolved through `allowed_gres`; never pass a raw GRES expression.

For MPI placement, use `--ntasks-per-node` only when requested and keep `ntasks <= nodes × ntasks-per-node`. Choose only one memory form:

```bash
slurm-agent submit ... -N 2 -n 8 --ntasks-per-node 4 -c 2 --mem-per-cpu 2G
```

`--mem-per-cpu` is checked using the requested usable CPU count and cannot be combined with `--mem`. Use `--exclusive` only when the user needs exclusive nodes and policy permits it; combine exclusive allocation with bounded per-node `--mem`, since Slurm may allocate memory for every usable CPU on the node.

Optionally select one policy-defined runtime alias:

```bash
slurm-agent submit ... --apptainer-image pytorch
slurm-agent submit ... --venv project-a
```

The options are mutually exclusive. Never pass a raw path, image URI, bind mount, environment override, or runtime command. Policy maps the alias to a fixed path. By default an Apptainer alias is required, and a trusted CLI-generated runner forces the uploaded payload to execute inside that image with a clean environment, read-only workspace, and only that job's artifact directory writable. Do not add Apptainer commands to the payload merely to recreate this wrapper.

Do not automatically retry an ambiguous failed submission, because the first submission might have reached Slurm. Inspect `list` once and ask for direction if the outcome cannot be established.

### Cluster information, filtered queries, diagnosis, usage, and wait

```bash
slurm-agent cluster-info
slurm-agent nodes --partition slurm-test --state idle
slurm-agent nodes --feature zen4-only
slurm-agent list --state PENDING,RUNNING --partition slurm-test --limit 50
slurm-agent history --days 7 --state COMPLETED,FAILED --limit 50
slurm-agent history --since 2026-10-01T00:00:00 --until 2026-10-08T00:00:00
slurm-agent fairshare
slurm-agent status 12345
slurm-agent diagnose 12345
slurm-agent usage 12345
slurm-agent wait 12345 --timeout 3600 --poll-interval 10
```

`cluster-info` returns only policy-allowed partition summaries. `nodes` reports node CPU, total/allocated/free memory, configured/used GRES, features, temporary disk, and unavailable reasons. Treat `memory.free_mib` as informational rather than scheduler-available memory. Partition filters must remain in `allowed_partitions`; `--feature` accepts only a policy constraint alias that resolves to one concrete feature.

`list` returns only active jobs belonging to the configured SSH user. Use its bounded state, partition, exact name, account-alias, sort, limit, and array-view filters instead of fetching unrelated jobs. `history` returns bounded accounting records for that fixed user and accepts the same selectors. Use either `--days` or a paired `--since`/`--until`, never both; explicit timestamps are cluster-local `YYYY-MM-DDTHH:MM:SS` values. Keep result and time windows within policy.

`status` checks active jobs through `squeue` and completed jobs through `sacct`. `diagnose` additionally returns requested resources, dependency/eligibility fields, stable finding codes, and available multifactor priority components for an explicit owned job. When `priority.available` is false, report that priority factors were unavailable rather than inventing them. Treat any expected start time as an estimate.

`fairshare` returns `sshare` values only for the configured user; unavailable data may indicate cluster accounting/fair-share configuration rather than an empty queue. `usage` verifies ownership and returns accounting efficiency plus live `sstat` steps when available. Missing efficiency fields mean Slurm did not report enough inputs; do not invent values. `wait` applies the same ownership check on every poll and is bounded by the policy maximum timeout. A wait timeout is a successful observation with `terminal: false` and `timed_out: true`. When `terminal` is true, inspect `job.state` and `job.exit_code`; terminal does not imply success. Never substitute another user, an unapproved partition, or a wildcard for an explicit job ID.

### Hold, release, and requeue

```bash
slurm-agent hold 12345
slurm-agent release 12345
slurm-agent requeue 12345
```

These operations change external state. Run them only when the user requests the operation for that explicit job or array task ID. A parent array ID affects the whole array. `release` only removes a user hold, and `requeue` restarts the batch script from the beginning with the same job ID. Do not retry an ambiguous control failure automatically.

### Update and signal

```bash
slurm-agent update 12345 --time 02:00:00
slurm-agent update 12345 --dependency afterok:12344 --array-concurrency 8
slurm-agent signal 12345 --signal USR1 --scope batch
```

Both commands change external state. Run them only for the explicit owned job or array task requested by the user. `update` exposes only time, dependency, and array-concurrency fields; do not propose generic `scontrol` fields. All dependency references must be owned and policy-approved. `signal` accepts only policy-allowed names and the scopes `steps`, `batch`, or `full`; default to `steps` unless the user needs the batch script or its full process tree. Do not retry an ambiguous result automatically.

### Logs

```bash
slurm-agent logs 12345
slurm-agent logs 12345 --stream stderr --tail 200
```

Only `stdout` and `stderr` are valid streams. Respect the configured line and byte limits. The CLI reads only its fixed per-job log files; do not request a filesystem path.

### Cancel

```bash
slurm-agent cancel 12345
```

Cancellation changes external state. Run it only when the user has requested cancellation of that explicit job or array task ID. A parent array ID cancels every task in that owned array, so use it only when the user explicitly requests whole-array cancellation. The CLI verifies existence and ownership before calling `scancel`; never broaden cancellation to a user, partition, or unrelated collection of jobs.

## Artifacts

Submission exports the job-specific `SLURM_AGENT_ARTIFACT_DIR` into the payload. A job script must place downloadable files beneath this directory:

```bash
artifact_dir="$SLURM_AGENT_ARTIFACT_DIR"
mkdir -p "$artifact_dir/results"
cp model.bin "$artifact_dir/results/model.bin"
```

Download one artifact with a safe path relative to that job directory:

```bash
slurm-agent artifacts 12345
slurm-agent artifact 12345 --path results/model.bin
```

Use `artifacts` to discover downloadable regular files for that explicit owned job. It returns only safe relative paths and byte sizes, bounded by policy; it does not list symlinks or arbitrary remote directories. Use a returned path with `artifact` when the user requests the download.

On success, read `artifact.local_path` from stdout JSON. The destination is derived as:

```text
SLURM_LOCAL_ARTIFACTS/<job-id>/<relative-artifact-path>
```

Do not add an output-path or overwrite flag. The CLI verifies job ownership, remote and local containment, regular-file type, transfer timeout, and `max_artifact_bytes`. It refuses to overwrite an existing local file. If the destination exists, do not delete it automatically; report the path and ask the user whether they want to move or remove it.

This is a controlled per-job listing plus single-file transfer, not a general filesystem browser. To retrieve multiple files, download each explicit safe relative path separately.

## JSON and failures

Success has `ok: true`; failure has `ok: false` and an `error.code` plus `error.message`. Preserve both the JSON error and process exit code when reporting failures.

```text
0 success
1 configuration/general failure
2 invalid arguments
3 policy or path denied
4 SSH, host verification, transfer, or timeout failure
5 Slurm operation failure
6 job, log, or artifact not found
7 ownership denied
```

For `JOB_NOT_OWNED_BY_USER`, `PATH_NOT_ALLOWED`, `PARTITION_NOT_ALLOWED`, `RUNTIME_ALIAS_NOT_ALLOWED`, `GRES_ALIAS_NOT_ALLOWED`, `RESOURCE_LIMIT_EXCEEDED`, `TIME_LIMIT_EXCEEDED`, `SIGNAL_NOT_ALLOWED`, `ARTIFACT_TOO_LARGE`, or `ARTIFACT_LIST_TOO_LARGE`, stop rather than attempting a workaround. For `ARTIFACT_ALREADY_EXISTS`, preserve the existing file. For transient query failures, a bounded retry is reasonable; do not blindly retry state-changing commands.
