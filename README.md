# Slurm Agent CLI

`slurm-agent` is an independent, constrained CLI for operating a remote Slurm cluster over verified SSH. It is designed to be the capability boundary used by OpenClaw or another agent through `exec`; it is **not** an OpenClaw plugin and has no OpenClaw SDK dependency.

The public interface contains only these Slurm lifecycle operations:

```text
slurm-agent submit
slurm-agent list
slurm-agent status JOB_ID
slurm-agent cancel JOB_ID
slurm-agent logs JOB_ID
```

There is deliberately no `exec`, `ssh`, `shell`, arbitrary path, file-transfer, or generic remote-command operation. Successful and failed operational commands write one JSON object to stdout. Audit events go to stderr or a protected file.

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
slurm-agent cancel 12345
```

Submissions always set output files to `.slurm-agent/logs/%j.out` and `%j.err` under the real remote workspace. `logs` can read only those generated names, limits lines and bytes, and verifies the resolved path is still inside the workspace. Consequently, `logs` does not read arbitrary output paths from jobs submitted outside this CLI.

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

## OpenClaw exec integration

Install the fixed package before OpenClaw starts, then configure its exec allowlist to permit only the resolved `slurm-agent` binary (for example `/usr/local/bin/slurm-agent`) and the five subcommand shapes above. Do not permit `ssh`, `bash`, `sh`, `node`, `npm`, `npx`, `scp`, or `sftp`. Keep SSH credentials and `SLURM_*` environment configuration outside agent-controlled prompts and arguments.

An agent invocation is simply:

```text
exec: /usr/local/bin/slurm-agent status 12345
```

The exact allowlist syntax depends on the surrounding exec sandbox. Prefer argument-aware rules; an executable-only allowlist still relies on this CLI's strict parser and absence of a generic command.

## Security model and limitations

- Every remote command consists of a compile-time executable allowlist plus separately shell-quoted arguments; no shell fragments are accepted.
- Job IDs, partition names, script segments, job names, resource units, and times use strict grammars. Unknown flags and duplicate flags are rejected.
- `cancel`, `status`, and `logs` confirm that Slurm reports the configured user as owner.
- Script and log paths are checked with remote `realpath`, preventing traversal and symlink escape.
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

Tests cover traversal, absolute paths, symlink escape, shell metacharacters/control characters, unexpected commands, Slurm argument injection, resource limits, partition denial, ownership denial, fixed log paths, parsers, and output construction. Integration tests use a typed mock transport and do not require a live cluster.
