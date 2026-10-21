import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { utils } from "ssh2";

export interface CliExecution {
  status: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate an SSH port");
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return address.port;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function fakeSlurmScript(root: string, user: string): string {
  const workspace = join(root, "remote-workspace");
  const calls = join(root, "slurm-calls.tsv");
  const mode = join(root, "slurm-mode");
  const transitionCount = join(root, "slurm-transition-count");
  return `#!/bin/sh
set -eu
name="$(basename "$0")"
{
  printf '%s' "$name"
  for argument in "$@"; do printf '\t%s' "$argument"; done
  printf '\n'
} >> ${shellQuote(calls)}
mode="$(cat ${shellQuote(mode)} 2>/dev/null || true)"
case "$name" in
  sbatch)
    mkdir -p ${shellQuote(join(workspace, ".slurm-agent", "logs"))}
    mkdir -p ${shellQuote(join(workspace, ".slurm-agent", "artifacts", "12345", "results"))}
    printf 'integration job output\n' > ${shellQuote(join(workspace, ".slurm-agent", "logs", "12345.out"))}
    printf 'integration artifact\n' > ${shellQuote(join(workspace, ".slurm-agent", "artifacts", "12345", "results", "model.txt"))}
    printf '12345\n'
    ;;
  squeue)
    if [ "$mode" = malformed ]; then
      printf 'malformed|queue|row\n'
      exit 0
    fi
    owner=${shellQuote(user)}
    if [ "$mode" = foreign ]; then owner=mallory; fi
    if [ "$mode" = completed ]; then exit 0; fi
    if [ "$mode" = transition ]; then
      count="$(cat ${shellQuote(transitionCount)} 2>/dev/null || printf '0')"
      if [ "$count" -gt 0 ]; then exit 0; fi
      printf '1\n' > ${shellQuote(transitionCount)}
    fi
    printf '12345|%s|integration|test|RUNNING|00:01|None|100|2026-10-21T00:00:00|2026-10-20T23:59:00|00:10:00|00:09:00|node01|1|1|research|normal|None\n' "$owner"
    ;;
  sacct)
    case " $* " in
      *"ElapsedRaw"*) printf '12345|${user}|integration|test|RUNNING|00:01|60|1|1|1G|cpu=1,mem=1G|cpu=1,mem=1G|00:00:30|1M|2M|0|0|0:0\n' ;;
      *"Start,End"*) printf '12345|${user}|integration|test|COMPLETED|00:01|2026-10-21T00:00:00|2026-10-21T00:01:00|0:0|1|1|1G|cpu=1,mem=1G\n' ;;
      *) printf '12345|${user}|integration|test|COMPLETED|00:01|0:0\n' ;;
    esac
    ;;
  sinfo)
    case " $* " in
      *" --Node "*) printf 'node01|test|up|idle|0/8/0/8|64000|0|60000|(null)|(null)|integration|integration|None|2026-10-21T00:00:00|100000\n' ;;
      *) printf 'test*|up|01:00:00|1|idle|0/8/0/8|(null)\n' ;;
    esac
    ;;
  scontrol)
    case " $* " in
      *" show job "*) printf 'JobId=12345 EligibleTime=2026-10-21T00:00:00 Dependency=(null) NumNodes=1 NumCPUs=1\n' ;;
    esac
    ;;
  sstat)
    printf '12345.batch|00:00:01|1M|2M|0|0|cpu=1,mem=1G\n'
    ;;
  sprio)
    printf '12345|100|1|2|3|4|5|6|7|8|9\n'
    ;;
  sshare)
    printf 'research|${user}|1|1.0|0|0|1.0|1.0|0|0\n'
    ;;
  scancel)
    ;;
  *)
    printf 'unsupported fake Slurm command: %s\n' "$name" >&2
    exit 127
    ;;
esac
`;
}

function policyYaml(): string {
  return `allowed_partitions: [test]
max_nodes: 2
max_ntasks: 8
max_ntasks_per_node: 8
max_cpus_per_task: 4
max_memory_gb: 16
max_gpus: 2
max_gpus_per_node: 2
max_gpus_per_task: 1
allow_exclusive: false
max_time_minutes: 60
max_wait_seconds: 60
max_history_days: 7
max_history_jobs: 50
max_list_jobs: 50
max_input_files: 8
max_input_file_bytes: 1048576
max_input_total_bytes: 4194304
max_array_tasks: 100
max_array_concurrency: 10
max_dependency_jobs: 8
allowed_dependency_types: [afterok, afterany]
allowed_launchers: [single]
allowed_mpi_modes: []
allowed_distributions: []
max_log_lines: 200
max_log_bytes: 1048576
max_artifact_bytes: 1048576
max_artifact_files: 100
allowed_signals: [TERM]
allowed_apptainer_images: {}
allowed_virtualenvs: {}
allowed_modules: {}
allowed_gres: {}
allowed_accounts: { research: research }
allowed_qos: { normal: normal }
allowed_constraints: {}
allowed_nodelists: {}
allowed_exclude_nodelists: {}
allowed_reservations: {}
max_script_bytes: 65536
max_script_args: 16
max_script_arg_length: 256
require_apptainer_for_generated_scripts: false
`;
}

export class SshTestCluster {
  readonly root: string;
  readonly workspace: string;
  readonly localWorkspace: string;
  readonly localArtifacts: string;
  readonly auditLog: string;
  readonly policyPath: string;
  readonly privateKey: string;
  readonly unauthorizedKey: string;
  readonly sessionDirectory: string;
  readonly user: string;
  readonly port: number;
  readonly fingerprint: string;
  readonly env: NodeJS.ProcessEnv;
  private readonly sshServer: ChildProcess;
  private serverOutput = "";

  private constructor(options: {
    root: string;
    port: number;
    fingerprint: string;
    sshServer: ChildProcess;
    user: string;
  }) {
    this.root = options.root;
    this.port = options.port;
    this.fingerprint = options.fingerprint;
    this.sshServer = options.sshServer;
    this.user = options.user;
    this.workspace = join(this.root, "remote-workspace");
    this.localWorkspace = join(this.root, "local-workspace");
    this.localArtifacts = join(this.root, "local-artifacts");
    this.auditLog = join(this.root, "audit.jsonl");
    this.policyPath = join(this.root, "policy.yaml");
    this.privateKey = join(this.root, "client-key");
    this.unauthorizedKey = join(this.root, "unauthorized-key");
    this.sessionDirectory = join(this.root, "sessions");
    this.env = {
      ...process.env,
      SLURM_SSH_HOST: "127.0.0.1",
      SLURM_SSH_PORT: String(this.port),
      SLURM_SSH_USER: this.user,
      SLURM_SSH_KEY_PATH: this.privateKey,
      SLURM_SSH_HOST_FINGERPRINT: this.fingerprint,
      SLURM_REMOTE_WORKSPACE: this.workspace,
      SLURM_LOCAL_JOB_WORKSPACE: this.localWorkspace,
      SLURM_LOCAL_ARTIFACTS: this.localArtifacts,
      SLURM_POLICY_PATH: this.policyPath,
      SLURM_AUDIT_LOG: this.auditLog,
      SLURM_SSH_SESSION_DIR: this.sessionDirectory,
      SLURM_SSH_SESSION_IDLE_TIMEOUT_MS: "60000",
      SLURM_SSH_SESSION_MAX_LIFETIME_MS: "60000",
      SLURM_COMMAND_TIMEOUT_MS: "5000",
    };
  }

  static async start(): Promise<SshTestCluster> {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-integration-"));
    const user = userInfo().username;
    const hostKey = join(root, "host-key");
    const clientKey = join(root, "client-key");
    const unauthorizedKey = join(root, "unauthorized-key");
    for (const path of [hostKey, clientKey, unauthorizedKey]) {
      const keyPair = utils.generateKeyPairSync("ed25519");
      writeFileSync(path, keyPair.private, { mode: 0o600 });
      writeFileSync(`${path}.pub`, keyPair.public, { mode: 0o600 });
    }
    writeFileSync(join(root, "authorized_keys"), readFileSync(`${clientKey}.pub`));
    const parsedHostKey = utils.parseKey(readFileSync(`${hostKey}.pub`));
    if (parsedHostKey instanceof Error) throw parsedHostKey;
    const fingerprint = `SHA256:${createHash("sha256").update(parsedHostKey.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;

    const workspace = join(root, "remote-workspace");
    const localWorkspace = join(root, "local-workspace");
    const bin = join(root, "fake-slurm", "bin");
    for (const directory of [workspace, localWorkspace, join(root, "local-artifacts"), join(root, "sessions"), bin]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    mkdirSync(join(localWorkspace, "jobs"));
    writeFileSync(join(localWorkspace, "jobs", "integration.sh"), "#!/bin/sh\necho integration\n", { mode: 0o700 });
    writeFileSync(join(root, "policy.yaml"), policyYaml(), { mode: 0o600 });
    writeFileSync(join(root, "slurm-mode"), "normal\n");
    const fakeCommand = join(bin, "fake-slurm");
    writeFileSync(fakeCommand, fakeSlurmScript(root, user), { mode: 0o700 });
    chmodSync(fakeCommand, 0o700);
    for (const command of ["sbatch", "squeue", "sacct", "sinfo", "scontrol", "sstat", "sprio", "sshare", "scancel"]) {
      symlinkSync("fake-slurm", join(bin, command));
    }

    const port = await availablePort();
    const sshServer = spawn(process.execPath, [resolve("tests/integration/support/ssh-test-server.mjs")], {
      env: {
        ...process.env,
        SLURM_TEST_HOST_KEY: hostKey,
        SLURM_TEST_AUTHORIZED_KEY: join(root, "authorized_keys"),
        SLURM_TEST_PORT: String(port),
        SLURM_TEST_USER: user,
        SLURM_TEST_PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cluster = new SshTestCluster({ root, port, fingerprint, sshServer, user });
    sshServer.stdout?.setEncoding("utf8");
    sshServer.stderr?.setEncoding("utf8");
    sshServer.stdout?.on("data", (chunk: string) => { cluster.serverOutput += chunk; });
    sshServer.stderr?.on("data", (chunk: string) => { cluster.serverOutput += chunk; });
    try {
      await cluster.waitUntilListening();
      return cluster;
    } catch (error) {
      cluster.stop();
      throw error;
    }
  }

  private async waitUntilListening(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!this.serverOutput.includes("READY")) {
      if (this.sshServer.exitCode !== null) {
        throw new Error(`Integration SSH server exited with ${this.sshServer.exitCode}: ${this.serverOutput}`);
      }
      if (Date.now() >= deadline) throw new Error(`Integration SSH server did not start: ${this.serverOutput}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }

  run(args: string[], overrides: NodeJS.ProcessEnv = {}): CliExecution {
    const result = spawnSync(process.execPath, [resolve("dist/cli.js"), ...args], {
      env: { ...this.env, ...overrides },
      encoding: "utf8",
      timeout: 15000,
    });
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(result.stdout) as Record<string, unknown>; } catch { /* asserted by the caller */ }
    const stderr = result.status === 0 ? result.stderr : [
      result.error?.message,
      result.stderr,
      result.stdout,
      this.serverOutput,
    ].filter(Boolean).join("\n");
    return { status: result.status, stdout: result.stdout, stderr, json };
  }

  setMode(mode: "normal" | "foreign" | "malformed" | "completed" | "transition"): void {
    writeFileSync(join(this.root, "slurm-mode"), `${mode}\n`);
    rmSync(join(this.root, "slurm-transition-count"), { force: true });
  }

  calls(): string[] {
    const path = join(this.root, "slurm-calls.tsv");
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
  }

  sessionMetadataPath(): string | undefined {
    if (!existsSync(this.sessionDirectory)) return undefined;
    const result = spawnSync("find", [this.sessionDirectory, "-maxdepth", "1", "-name", "*.json", "-print", "-quit"], {
      encoding: "utf8",
    });
    return result.stdout.trim() || undefined;
  }

  stop(): void {
    const metadata = this.sessionMetadataPath();
    if (metadata) {
      try {
        const parsed = JSON.parse(readFileSync(metadata, "utf8")) as { pid?: number };
        if (parsed.pid && Number.isInteger(parsed.pid)) process.kill(parsed.pid, "SIGTERM");
      } catch { /* best-effort cleanup */ }
    }
    if (this.sshServer.exitCode === null) this.sshServer.kill("SIGTERM");
    if (existsSync(this.root)) rmSync(this.root, { recursive: true, force: true });
  }

  assertFixtureLayout(): void {
    if (readlinkSync(join(this.root, "fake-slurm", "bin", "squeue")) !== "fake-slurm") {
      throw new Error("Fake Slurm command layout is invalid");
    }
  }
}
