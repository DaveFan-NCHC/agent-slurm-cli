---
name: slurm-agent-operations
description: "Operate jobs through the constrained slurm-agent CLI, including submission, listing, status, logs, cancellation, and controlled artifact downloads. Use for Slurm job lifecycle requests handled by this project; do not use it for cluster administration or generic SSH access."
---

# Slurm Agent Operations

Use the installed `slurm-agent` executable as the only interface to the remote Slurm cluster.

## Boundaries

- Invoke only `submit`, `list`, `status`, `logs`, `cancel`, or `artifact`.
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

Defaults are one node, one task, one CPU per task, `1G`, and `01:00:00`. Resource values and the partition must remain within the configured policy. Record the returned `job_id`; use only that decimal ID in later commands.

Optionally select one policy-defined runtime alias:

```bash
slurm-agent submit ... --apptainer-image pytorch
slurm-agent submit ... --venv project-a
```

The options are mutually exclusive. Never pass a raw path, image URI, bind mount, environment override, or runtime command. Policy maps the alias to a fixed path. By default an Apptainer alias is required, and a trusted CLI-generated runner forces the uploaded payload to execute inside that image with a clean environment, read-only workspace, and only that job's artifact directory writable. Do not add Apptainer commands to the payload merely to recreate this wrapper.

Do not automatically retry an ambiguous failed submission, because the first submission might have reached Slurm. Inspect `list` once and ask for direction if the outcome cannot be established.

### List and status

```bash
slurm-agent list
slurm-agent status 12345
```

`list` returns only jobs belonging to the configured SSH user. `status` checks active jobs through `squeue` and completed jobs through `sacct`. Never substitute another user, a partition, or a wildcard for an explicit job ID.

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

Cancellation changes external state. Run it only when the user has requested cancellation of that explicit job ID. The CLI verifies existence and ownership before calling `scancel`; never broaden cancellation to a user, partition, or collection of jobs.

## Artifacts

Submission exports the job-specific `SLURM_AGENT_ARTIFACT_DIR` into the payload. A job script must place downloadable files beneath this directory:

```bash
artifact_dir="$SLURM_AGENT_ARTIFACT_DIR"
mkdir -p "$artifact_dir/results"
cp model.bin "$artifact_dir/results/model.bin"
```

Download one artifact with a safe path relative to that job directory:

```bash
slurm-agent artifact 12345 --path results/model.bin
```

On success, read `artifact.local_path` from stdout JSON. The destination is derived as:

```text
SLURM_LOCAL_ARTIFACTS/<job-id>/<relative-artifact-path>
```

Do not add an output-path or overwrite flag. The CLI verifies job ownership, remote and local containment, regular-file type, transfer timeout, and `max_artifact_bytes`. It refuses to overwrite an existing local file. If the destination exists, do not delete it automatically; report the path and ask the user whether they want to move or remove it.

This is a controlled single-file transfer, not an artifact browser. To retrieve multiple known files, download each explicit relative path separately. Do not infer filenames by probing arbitrary directories.

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

For `JOB_NOT_OWNED_BY_USER`, `PATH_NOT_ALLOWED`, `PARTITION_NOT_ALLOWED`, `RUNTIME_ALIAS_NOT_ALLOWED`, `RESOURCE_LIMIT_EXCEEDED`, `TIME_LIMIT_EXCEEDED`, or `ARTIFACT_TOO_LARGE`, stop rather than attempting a workaround. For `ARTIFACT_ALREADY_EXISTS`, preserve the existing file. For transient query failures, a bounded retry is reasonable; do not blindly retry `submit` or `cancel`.
