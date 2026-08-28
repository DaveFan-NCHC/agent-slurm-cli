## 1. Project Goal

建立一個獨立的 **Slurm Agent CLI**，透過 SSH 操作遠端 Slurm Cluster，提供一組安全、結構化、受限的 Slurm job lifecycle commands，供 Agent 透過 `exec` 呼叫。

核心架構：

```text
      Agent
        │
        │ exec
        ▼
    slurm-agent
        │
        │ controlled SSH
        ▼
 Slurm Login Node
        │
        ├── sbatch
        ├── squeue
        ├── sacct
        ├── scancel
        └── controlled log access
```

`slurm-agent` 是真正的 capability boundary。

Agent 不應直接取得：

```text
ssh
bash
sh
sbatch
squeue
sacct
scancel
scp
sftp
arbitrary remote command
```

---

# 2. CLI Interface

第一版至少提供：

```bash
slurm-agent submit
slurm-agent list
slurm-agent status
slurm-agent cancel
slurm-agent logs
slurm-agent artifact
```

例如：

```bash
slurm-agent submit \
  --partition slurm-test \
  --ntasks 4 \
  --mem 8G \
  --time 01:00:00 \
  --apptainer-image pytorch \
  jobs/test.sh
```

輸出必須預設為 structured JSON：

```json
{
  "ok": true,
  "job_id": "12345"
}
```

---

# 3. Package Form

建議實作成 Node.js / TypeScript npm package。

例如：

```json
{
  "name": "@nchc/slurm-agent",
  "bin": {
    "slurm-agent": "./dist/cli.js"
  }
}
```

使用方式：

```bash
npm install -g @nchc/slurm-agent
```

之後：

```bash
slurm-agent status 12345
```

開發環境也應支援：

```bash
npx @nchc/slurm-agent status 12345
```

但 production 不應依賴每次 runtime 動態下載 package。

---

# 4. Design Principle

不要提供：

```bash
slurm-agent exec "..."
slurm-agent ssh "..."
slurm-agent run "..."
slurm-agent command "..."
```

任何 generic remote execution 都禁止。

只能暴露明確 Slurm semantic operations。

---

# 5. SSH Layer

SSH 只存在於 CLI 內部。

建議建立：

```text
src/
  transport/
    ssh.ts
```

介面例如：

```ts
interface RemoteExecutor {
  run(command: SafeCommand): Promise<RemoteResult>;
}
```

這個介面只能被內部 Slurm client 使用。

CLI user 不得自行指定任意 remote command。

---

# 6. Required Commands

## `slurm-agent submit`

用途：

```text
submit an Agent-generated local script through controlled staging
```

建議參數：

```text
SCRIPT (positional, below SLURM_LOCAL_JOB_WORKSPACE)
--partition
--nodes
--ntasks
--cpus-per-task
--mem
--time
--job-name
```

範例：

```bash
slurm-agent submit \
  --partition slurm-test \
  --ntasks 4 \
  --apptainer-image pytorch \
  jobs/naca.sh
```

必須驗證：

```text
partition allowlist
maximum nodes
maximum ntasks
maximum CPUs
maximum memory
maximum walltime
local script path, size, type, shebang, and absence of #SBATCH directives
job name
```

---

## `slurm-agent list`

例如：

```bash
slurm-agent list
```

輸出：

```json
{
  "ok": true,
  "jobs": [
    {
      "job_id": "12345",
      "name": "test",
      "partition": "slurm-test",
      "state": "RUNNING",
      "elapsed": "00:03:21"
    }
  ]
}
```

只能列出 configured SSH user 的 jobs。

---

## `slurm-agent status`

例如：

```bash
slurm-agent status 12345
```

內部可使用：

```text
squeue
↓ if no longer active
sacct
```

輸出：

```json
{
  "ok": true,
  "job": {
    "job_id": "12345",
    "state": "COMPLETED",
    "exit_code": "0:0",
    "elapsed": "00:10:31"
  }
}
```

---

## `slurm-agent cancel`

例如：

```bash
slurm-agent cancel 12345
```

執行 `scancel` 前必須確認：

```text
job exists
job belongs to configured user
```

禁止：

```bash
slurm-agent cancel --user all
slurm-agent cancel --partition xxx
```

只允許 explicit job ID。

---

## `slurm-agent logs`

例如：

```bash
slurm-agent logs 12345
```

可選：

```bash
slurm-agent logs 12345 --stream stdout --tail 200
```

Agent 不得自行提供任意 filesystem path。

CLI 必須自己解析或保存該 job 的 output path。

限制：

```text
max lines
max bytes
workspace path containment
```

---

## `slurm-agent artifact`

例如：

```bash
slurm-agent artifact 12345 --path results/model.bin
```

只能下載該 job 的固定 artifact 目錄內的單一檔案，並存到本機設定的 `SLURM_LOCAL_ARTIFACTS/<job-id>/`。不得讓 Agent 指定任意本機輸出路徑或覆寫既有檔案。

---

# 7. Local Script and Remote Workspace

Agent 產生的腳本位於執行 CLI 的本機：

```text
SLURM_LOCAL_JOB_WORKSPACE=/var/lib/slurm-agent/jobs
```

若 Agent 指定 `jobs/test.sh`，只能讀取：

```text
/var/lib/slurm-agent/jobs/jobs/test.sh
```

CLI 驗證並 hash 腳本後，上傳到自行產生的遠端 staging path。Agent 不得指定遠端目的地。

設定：

```text
SLURM_REMOTE_WORKSPACE=/home/agent/workspace
```

遠端腳本只能存放於：

```text
/home/agent/workspace/.slurm-agent/submissions/<uuid>/
```

必須阻止：

```text
../
../../
absolute external path
symlink escape
#SBATCH directives
oversized script
```

例如以下全部拒絕：

```text
/etc/passwd
/home/other-user/test.sh
../../secret
```

---

# 8. SSH Configuration

使用環境變數：

```text
SLURM_SSH_HOST
SLURM_SSH_PORT
SLURM_SSH_USER
SLURM_SSH_KEY_PATH
SLURM_SSH_KNOWN_HOSTS
SLURM_REMOTE_WORKSPACE
SLURM_LOCAL_JOB_WORKSPACE
SLURM_LOCAL_ARTIFACTS
SLURM_REMOTE_APPTAINER_PATH
```

Private key 本身不要放進 command arguments 或 config file。

使用：

```text
SLURM_SSH_KEY_PATH
```

指向 key file。

---

# 9. Host Verification

Production 必須驗證 SSH host identity。

不要預設：

```text
StrictHostKeyChecking=no
```

支援：

```text
known_hosts
fingerprint verification
```

---

# 10. Policy

建立獨立 policy layer。

例如：

```yaml
allowed_partitions:
  - slurm-test

max_nodes: 2
max_ntasks: 16
max_cpus_per_task: 8
max_memory_gb: 64
max_time_minutes: 240
```

不要把限制散落在 CLI command handler 裡。

---

# 11. Safe Command Construction

禁止：

```ts
const cmd = `sbatch ${userInput}`;
```

所有 CLI arguments 必須：

```text
parse
validate
normalize
policy check
escape
construct
```

如果 remote SSH library 最終只能接受 shell command string，要實作嚴格 shell escaping。

任何 user-supplied value 都不得直接 concatenate。

---

# 12. Output Contract

所有 commands 預設 stdout 必須是 JSON。

成功：

```json
{
  "ok": true,
  "job_id": "12345"
}
```

失敗：

```json
{
  "ok": false,
  "error": {
    "code": "PARTITION_NOT_ALLOWED",
    "message": "Partition gpu is not permitted."
  }
}
```

不要把 CLI table 當主要 machine interface。

可選擇提供：

```bash
--human
```

給人類使用。

但 Agent 預設應使用 JSON。

---

# 13. Exit Codes

CLI 必須有穩定 exit code。

建議：

```text
0 success
1 general failure
2 invalid arguments
3 policy denied
4 SSH failure
5 Slurm operation failure
6 job not found
7 permission / ownership denied
```

JSON error code 與 process exit code 都要存在。

---

# 14. Error Codes

至少建立：

```text
INVALID_ARGUMENT
INVALID_JOB_ID

SSH_CONNECTION_FAILED
SSH_AUTH_FAILED
SSH_HOST_VERIFICATION_FAILED

PARTITION_NOT_ALLOWED
RESOURCE_LIMIT_EXCEEDED
TIME_LIMIT_EXCEEDED

PATH_NOT_ALLOWED
SCRIPT_NOT_FOUND

JOB_NOT_FOUND
JOB_NOT_OWNED_BY_USER

SLURM_SUBMIT_FAILED
SLURM_QUERY_FAILED
SLURM_CANCEL_FAILED

REMOTE_COMMAND_TIMEOUT
```

---

# 15. Audit Logging

記錄：

```text
timestamp
action
SSH user
job ID
resources
policy decision
result
remote exit code
```

不要記錄：

```text
SSH key
password
secret
environment credentials
```

Audit log 應寫 stderr、log file 或 dedicated logger。

不得污染 stdout JSON。

---

# 16. Suggested Structure

```text
slurm-agent/
├── GOAL.md
├── README.md
├── package.json
├── tsconfig.json
│
├── src/
│   ├── cli.ts
│   │
│   ├── commands/
│   │   ├── submit.ts
│   │   ├── list.ts
│   │   ├── status.ts
│   │   ├── cancel.ts
│   │   └── logs.ts
│   │
│   ├── slurm/
│   │   ├── client.ts
│   │   ├── parser.ts
│   │   ├── commands.ts
│   │   └── types.ts
│   │
│   ├── transport/
│   │   ├── ssh.ts
│   │   └── types.ts
│   │
│   ├── policy/
│   │   ├── loader.ts
│   │   ├── validator.ts
│   │   └── path.ts
│   │
│   ├── config/
│   │   └── loader.ts
│   │
│   ├── audit/
│   │   └── logger.ts
│   │
│   └── errors/
│       └── errors.ts
│
├── tests/
│   ├── commands/
│   ├── policy/
│   ├── parser/
│   └── integration/
│
└── examples/
    └── config.yaml
```

---

# 17. Implementation Order

## Phase 1

建立可執行 CLI：

```bash
slurm-agent --help
slurm-agent --version
```

---

## Phase 2

建立 SSH transport。

完成：

```text
connect
host verify
execute controlled command
stdout
stderr
exit code
timeout
```

---

## Phase 3

先做 read-only：

```bash
slurm-agent list
slurm-agent status <job-id>
```

---

## Phase 4

做：

```bash
slurm-agent submit
```

加入完整 resource / path / partition policy。

---

## Phase 5

做：

```bash
slurm-agent cancel
```

加入 ownership validation。

---

## Phase 6

做：

```bash
slurm-agent logs
```

加入 filesystem containment。

---

## Phase 7

完成 security tests。

---

# 18. Security Tests

必須測：

```text
../ traversal
absolute path escape
symlink escape

;
&&
||
|
$()
backticks
newline
quotes

unexpected Slurm flags
argument injection

oversized CPU
oversized memory
oversized nodes
oversized time

unauthorized partition
other user's job ID
arbitrary file read
```

全部必須被拒絕。

---

# 19. Deployment Model

預期 production 使用方式：

```text
container / host bootstrap
       ↓
install fixed CLI version
       ↓
slurm-agent available in PATH
       ↓
Agent exec allowlist
       ↓
slurm-agent only
```

不要讓 Agent 依賴：

```text
npm
npx arbitrary package
node arbitrary-script.js
ssh
bash
```

最好固定 executable：

```text
/usr/local/bin/slurm-agent
```

---

# 20. Non-Goals

不要做：

```text
generic SSH client
generic shell
remote terminal
SFTP browser
SCP arbitrary files
sudo
sacctmgr
node administration
partition administration
interactive srun
port forwarding
```

---

# 21. Definition of Done

專案完成時：

```bash
slurm-agent submit ...
slurm-agent list
slurm-agent status ...
slurm-agent logs ...
slurm-agent cancel ...
slurm-agent artifact ...
```

都能正常使用。

而以下不可行：

```bash
slurm-agent exec ...
slurm-agent ssh ...
slurm-agent shell ...
```

最終 security boundary：

```text
Agent
  │
  │ exec
  ▼
slurm-agent CLI
  │
  ├── schema
  ├── validation
  ├── policy
  ├── path containment
  ├── ownership
  └── audit
  │
  ▼
controlled SSH
  │
  ▼
Slurm Login Node
  │
  ▼
Slurm
```

---

# 22. Instructions to Implementing Agent

先完成：

```text
CLI
→ SSH
→ read-only Slurm
→ submit
→ cancel
→ logs
→ policy
→ security tests
```

如果某項功能似乎需要 arbitrary SSH command，不要增加 generic command interface。

應新增更窄的 Slurm-specific subcommand。

完成後回報：

```text
1. architecture
2. implemented commands
3. files changed
4. tests run
5. security tests
6. remaining limitations
7. installation steps
```
