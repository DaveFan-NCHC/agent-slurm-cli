# Slurm Agent CLI

`slurm-agent` is an independent, constrained CLI for operating a remote Slurm cluster over verified SSH. It is designed to be the capability boundary used by another agent through `exec`.

The public interface contains only these Slurm lifecycle operations:

```text
slurm-agent submit
slurm-agent cluster-info
slurm-agent list
slurm-agent history
slurm-agent status JOB_ID
slurm-agent usage JOB_ID
slurm-agent cancel JOB_ID
slurm-agent logs JOB_ID
slurm-agent artifact JOB_ID --path RELATIVE_PATH
slurm-agent wait JOB_ID
```

There is deliberately no `exec`, `ssh`, `shell`, arbitrary path, generic file-transfer, or generic remote-command operation. Successful and failed operational commands write one JSON object to stdout. Audit events go to stderr or a protected file.

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
npm install -g @nchc/slurm-agent@0.5.0
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
export SLURM_POLICY_PATH=/etc/slurm-agent/policy.yaml
export SLURM_AUDIT_LOG=/var/log/slurm-agent/audit.jsonl
```

`SLURM_SSH_KNOWN_HOSTS` must contain a plain hostname entry (or `[host]:port` for a non-default port). Hashed hostnames are not parsed. As an alternative, set `SLURM_SSH_HOST_FINGERPRINT` to a pinned `SHA256:...` host-key fingerprint. One of these verification methods is mandatory; insecure host-key checking is not available. The private key is read only from `SLURM_SSH_KEY_PATH`.

Copy [examples/slurm-agent-policy.example.yaml](examples/slurm-agent-policy.example.yaml) to the protected `SLURM_POLICY_PATH` location and adjust its partition, resource limits, and optional aliases. Unknown policy keys fail closed.

Policy aliases map agent-visible logical names to operator-controlled runtime paths or GRES requests:

```yaml
allowed_apptainer_images:
  pytorch: /opt/apptainer/pytorch.sif
allowed_virtualenvs:
  project-a: /home/agent/venvs/project-a
max_gpus: 4
allowed_gres:
  a100x1: gpu:a100:1
max_wait_seconds: 86400
max_history_days: 30
max_history_jobs: 200
max_array_tasks: 1000
max_array_concurrency: 32
max_dependency_jobs: 16
allowed_dependency_types: [after, afterany, aftercorr, afternotok, afterok, singleton]
max_script_bytes: 65536
max_script_args: 32
max_script_arg_length: 1024
require_apptainer_for_generated_scripts: true
```

Arrays and dependencies are opt-in for upgrades: if their new policy keys are omitted, their limits and dependency allowlist default to disabled. Set the bounded values explicitly as above to enable them.

Aliases are accepted from the CLI; raw image, virtualenv, and GRES values are not. `max_gpus: 0` disables direct `--gpus` requests.

### Cluster path visibility

`slurm-agent` submits from the login node, but the trusted runner and payload execute on a compute node. Configure remote paths with the following visibility:

| Path | Required visibility | Reason |
|---|---|---|
| `SLURM_REMOTE_WORKSPACE` | Must be a shared filesystem mounted at the same absolute path on the login node and every eligible compute node | It contains `.slurm-agent/submissions`, logs, and artifacts. Compute nodes read the staged payload and write logs/artifacts; the login node later reads or downloads them. |
| `allowed_apptainer_images.*` | Must resolve to the same image at the same absolute path on the login node and every eligible compute node | The login node validates the image, while the compute node executes it. A shared filesystem is recommended; an identically replicated image also works. |
| `allowed_virtualenvs.*` | Must resolve to the same environment at the same absolute path on the login node and every eligible compute node | The login node validates `bin/python`, while the compute node runs the environment. A shared filesystem is recommended; an identical installation on every node also works. |
| `SLURM_REMOTE_APPTAINER_PATH` | Must be executable at the same absolute path on the login node and every eligible compute node | It may be installed locally on each node and does not itself need to be on shared storage. |

Typical shared filesystems include NFS, Lustre, GPFS, and BeeGFS. A directory local only to the login node, such as its private `/tmp`, is not suitable for `SLURM_REMOTE_WORKSPACE` or a non-replicated runtime alias. The CLI can validate remote paths only on the login node before submission, so a missing compute-node mount may not be detected until the job starts.

These paths belong only to the machine running the CLI and do **not** need to be visible on Slurm nodes: `SLURM_LOCAL_JOB_WORKSPACE`, `SLURM_LOCAL_ARTIFACTS`, `SLURM_SSH_KEY_PATH`, `SLURM_SSH_KNOWN_HOSTS`, `SLURM_POLICY_PATH`, and `SLURM_AUDIT_LOG`.

The configured SSH account should also be restricted at the cluster and filesystem layers. The CLI boundary complements, but does not replace, least-privilege Unix and Slurm configuration.

## Usage

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
{"ok":true,"job_id":"12345"}
```

Choose at most one runtime alias per submission:

```bash
slurm-agent submit -p slurm-test --apptainer-image pytorch jobs/train.sh
slurm-agent submit -p slurm-test --venv project-a jobs/train.sh
```

GPU resources can be requested either by a policy-bounded count or by an operator-defined GRES alias. The two forms are mutually exclusive:

```bash
slurm-agent submit -p slurm-test --gpus 1 --apptainer-image pytorch jobs/train.sh
slurm-agent submit -p slurm-test --gres a100x1 --apptainer-image pytorch jobs/train.sh
```

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

With the default secure policy, agent-generated scripts require an approved Apptainer alias. The CLI-generated runner forces execution through `--containall` and `--cleanenv`, mounts the remote workspace read-only, and mounts only that job's controlled artifact directory read-write. The agent script does not invoke Apptainer itself:

```bash
#!/bin/sh
set -eu
python train.py "$@"
```

The script must be valid UTF-8, begin with a shebang, fit the policy size limit, and contain no `#SBATCH` directives. Scheduler resources must be expressed through CLI options. Virtualenv-only or direct host execution is not a security sandbox and is available only when an operator sets `require_apptainer_for_generated_scripts: false`.

Other operations:

```bash
slurm-agent cluster-info
slurm-agent list
slurm-agent history --days 7 --state COMPLETED --limit 50
slurm-agent status 12345
slurm-agent usage 12345
slurm-agent wait 12345 --timeout 3600 --poll-interval 10
slurm-agent logs 12345 --stream stdout --tail 200
slurm-agent artifact 12345 --path results/model.bin
slurm-agent cancel 12345
```

`cluster-info` returns partition availability, time limit, node state, CPU counts, and configured GRES only for `allowed_partitions`. `wait` polls the owned job until it reaches a terminal state. If its bounded timeout expires, it returns `ok: true`, `terminal: false`, `timed_out: true`, and the last observed job state. `terminal: true` means the job has stopped, not necessarily that it succeeded; callers must inspect `job.state` and `job.exit_code`.

`history` uses one bounded accounting query and returns allocation records only for the configured SSH user. `--days` and `--limit` are capped by `max_history_days` and `max_history_jobs`; `--state` accepts a fixed set of Slurm job states.

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
slurm-agent artifact 12345 --path results/model.bin
```

It verifies job ownership and both remote and local path containment, enforces `max_artifact_bytes`, and refuses to overwrite an existing local file. The resulting file is stored at `SLURM_LOCAL_ARTIFACTS/12345/results/model.bin`; callers cannot provide an arbitrary local output path.

```json
{"ok":true,"artifact":{"job_id":"12345","remote_path":"/home/slurm-agent/workspace/.slurm-agent/artifacts/12345/results/model.bin","local_path":"/var/lib/slurm-agent/artifacts/12345/results/model.bin","bytes":1048576}}
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

## Security model and limitations

- Every remote command consists of a compile-time executable allowlist plus separately shell-quoted arguments; no shell fragments are accepted.
- Job IDs, array specifications, dependencies, partition names, script segments, job names, resource units, and times use strict grammars. Unknown flags and duplicate flags are rejected.
- Runtime selection accepts only policy-defined logical aliases. Apptainer images must resolve to regular files; virtual environments must contain an executable `bin/python`. Raw runtime paths, image URIs, bind mounts, and caller-provided commands are unavailable.
- Agent scripts come only from `SLURM_LOCAL_JOB_WORKSPACE`; symlinks, traversal, oversized files, invalid UTF-8, missing shebangs, and embedded `#SBATCH` directives are rejected. The exact bytes are hashed before upload.
- Upload destinations are random, CLI-generated directories below `.slurm-agent/submissions`; callers cannot select a remote destination. Payload and trusted runner uploads use temporary files followed by atomic rename.
- The batch environment exports only controlled `SLURM_AGENT_*` values, not the complete SSH process environment.
- `cancel`, `status`, `usage`, `wait`, `logs`, and `artifact` confirm that Slurm reports the configured user as owner. Dependency references receive the same ownership check before submission. `history` fixes its query to that user and rejects unexpected cross-user rows.
- Script and log paths are checked with remote `realpath`, preventing traversal and symlink escape.
- Artifact transfer is an internal, single-file SFTP stream after remote containment checks; it is not an SFTP browser. The destination is derived from trusted configuration and the job ID, and is created without overwrite.
- Audit records never contain private keys, credentials, command stderr, or environment values.
- The remote host needs GNU-compatible `realpath`, `test`, `mkdir`, and `tail`, plus `sbatch`, `squeue`, `sacct`, `scancel`, `sinfo`, and `sstat` in its non-interactive PATH.
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
