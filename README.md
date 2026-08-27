# Slurm Agent CLI

`slurm-agent` is an independent, constrained CLI for operating a remote Slurm cluster over verified SSH. It is designed to be the capability boundary used by another agent through `exec`.

The public interface contains only these Slurm lifecycle operations:

```text
slurm-agent submit
slurm-agent list
slurm-agent status JOB_ID
slurm-agent cancel JOB_ID
slurm-agent logs JOB_ID
slurm-agent artifact JOB_ID --path RELATIVE_PATH
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
npm install -g @nchc/slurm-agent@0.1.0
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
export SLURM_LOCAL_ARTIFACTS=/var/lib/slurm-agent/artifacts
export SLURM_POLICY_PATH=/etc/slurm-agent/policy.yaml
export SLURM_AUDIT_LOG=/var/log/slurm-agent/audit.jsonl
```

`SLURM_SSH_KNOWN_HOSTS` must contain a plain hostname entry (or `[host]:port` for a non-default port). Hashed hostnames are not parsed. As an alternative, set `SLURM_SSH_HOST_FINGERPRINT` to a pinned `SHA256:...` host-key fingerprint. One of these verification methods is mandatory; insecure host-key checking is not available. The private key is read only from `SLURM_SSH_KEY_PATH`.

Copy [examples/config.yaml](examples/config.yaml) to the protected `SLURM_POLICY_PATH` location and adjust its partition and resource limits. Unknown policy keys fail closed.

The configured SSH account should also be restricted at the cluster and filesystem layers. The CLI boundary complements, but does not replace, least-privilege Unix and Slurm configuration.

## Usage

Scripts already present below `SLURM_REMOTE_WORKSPACE` can be submitted by relative path:

```bash
slurm-agent submit \
  --script jobs/naca.sh \
  --partition slurm-test \
  --nodes 1 \
  --ntasks 4 \
  --cpus-per-task 2 \
  --memory 8G \
  --time 01:00:00 \
  --job-name naca
```

```json
{"ok":true,"job_id":"12345"}
```

Other operations:

```bash
slurm-agent list
slurm-agent status 12345
slurm-agent logs 12345 --stream stdout --tail 200
slurm-agent artifact 12345 --path results/model.bin
slurm-agent cancel 12345
```

Submissions always set output files to `.slurm-agent/logs/%j.out` and `%j.err` under the real remote workspace. `logs` can read only those generated names, limits lines and bytes, and verifies the resolved path is still inside the workspace. Consequently, `logs` does not read arbitrary output paths from jobs submitted outside this CLI.

### Job artifacts

`submit` supplies `SLURM_AGENT_ARTIFACT_ROOT` to the job. A job places downloadable files in its own ID directory:

```bash
artifact_dir="$SLURM_AGENT_ARTIFACT_ROOT/$SLURM_JOB_ID"
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
- Job IDs, partition names, script segments, job names, resource units, and times use strict grammars. Unknown flags and duplicate flags are rejected.
- `cancel`, `status`, `logs`, and `artifact` confirm that Slurm reports the configured user as owner.
- Script and log paths are checked with remote `realpath`, preventing traversal and symlink escape.
- Artifact transfer is an internal, single-file SFTP stream after remote containment checks; it is not an SFTP browser. The destination is derived from trusted configuration and the job ID, and is created without overwrite.
- Audit records never contain private keys, credentials, command stderr, or environment values.
- The remote host needs GNU-compatible `realpath`, `test`, `mkdir`, and `tail`, plus `sbatch`, `squeue`, `sacct`, and `scancel` in its non-interactive PATH.
- Completed-job lookup depends on Slurm accounting (`sacct`) retention and permissions. If no allocation record is visible, the CLI reports `JOB_NOT_FOUND`.
- SSH certificates, encrypted private keys requiring an interactive passphrase, wildcard/hashed `known_hosts` entries, job arrays, and federation IDs are not supported in this first release.

## Development

```bash
npm run typecheck
npm test
npm run build
```

## GitLab CI

[`.gitlab-ci.yml`](.gitlab-ci.yml) runs for branches, tags, and merge requests. Type checking and tests run in parallel on Node.js 22; the package job starts only after both pass and retains `dist/` plus the npm tarball for seven days.

Tests cover traversal, absolute paths, remote/local symlink escape, shell metacharacters/control characters, unexpected commands, Slurm argument injection, resource limits, partition denial, ownership denial, fixed log/artifact paths, parsers, and output construction. Integration tests use a typed mock transport and do not require a live cluster.
