## 1. Project Goal

建立一個獨立的 **Slurm Agent CLI**，透過 SSH 操作遠端 Slurm Cluster，提供一組安全、結構化、受限的 Slurm job lifecycle commands，供 OpenClaw 或其他 Agent 透過 `exec` 呼叫。

本專案**不是 OpenClaw Plugin**。

不得依賴 OpenClaw Plugin SDK。

核心架構：

```text
OpenClaw / Other Agent
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
```

例如：

```bash
slurm-agent submit \
  --script jobs/test.sh \
  --partition slurm-test \
  --ntasks 4 \
  --memory 8G \
  --time 01:00:00
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

# 4. OpenClaw Integration

OpenClaw integration 僅透過 `exec`。

例如：

```text
OpenClaw
   ↓
exec
   ↓
slurm-agent status 12345
```

本專案不應：

```text
import OpenClaw SDK
registerTool()
definePlugin()
depend on OpenClaw runtime
```

CLI 必須可以完全獨立運作。

---

# 5. Design Principle

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

# 6. SSH Layer

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

# 7. Required Commands

## `slurm-agent submit`

用途：

```text
submit a predefined script
```

建議參數：

```text
--script
--partition
--nodes
--ntasks
--cpus-per-task
--memory
--time
--job-name
```

範例：

```bash
slurm-agent submit \
  --script jobs/naca.sh \
  --partition slurm-test \
  --ntasks 4
```

必須驗證：

```text
partition allowlist
maximum nodes
maximum ntasks
maximum CPUs
maximum memory
maximum walltime
script path
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

# 8. Remote Workspace

設定：

```text
SLURM_REMOTE_WORKSPACE=/home/agent/workspace
```

若 Agent 指定：

```text
jobs/test.sh
```

只能 resolve 成：

```text
/home/agent/workspace/jobs/test.sh
```

必須阻止：

```text
../
../../
absolute external path
symlink escape
```

例如以下全部拒絕：

```text
/etc/passwd
/home/other-user/test.sh
../../secret
```

---

# 9. SSH Configuration

使用環境變數：

```text
SLURM_SSH_HOST
SLURM_SSH_PORT
SLURM_SSH_USER
SLURM_SSH_KEY_PATH
SLURM_SSH_KNOWN_HOSTS
SLURM_REMOTE_WORKSPACE
```

Private key 本身不要放進 command arguments 或 config file。

使用：

```text
SLURM_SSH_KEY_PATH
```

指向 key file。

---

# 10. Host Verification

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

# 11. Policy

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

# 12. Safe Command Construction

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

# 13. Output Contract

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

# 14. Exit Codes

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

# 15. Error Codes

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

# 16. Audit Logging

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

# 17. Suggested Structure

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

# 18. Implementation Order

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

# 19. Security Tests

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

# 20. OpenClaw Deployment Model

預期 production 使用方式：

```text
container / host bootstrap
       ↓
install fixed CLI version
       ↓
slurm-agent available in PATH
       ↓
OpenClaw exec allowlist
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

如果 OpenClaw 的 exec policy 能限制 executable，優先只允許這個 binary。

---

# 21. Non-Goals

不要做：

```text
OpenClaw Plugin
OpenClaw SDK integration
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

# 22. Definition of Done

專案完成時：

```bash
slurm-agent submit ...
slurm-agent list
slurm-agent status ...
slurm-agent logs ...
slurm-agent cancel ...
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

CLI 必須可以完全離開 OpenClaw 獨立使用。

---

# 23. Instructions to Implementing Agent

請直接實作專案，不要把它改成 OpenClaw Plugin。

如果需要與 OpenClaw 整合，只需在 README 提供：

```text
如何安裝 slurm-agent
如何讓 OpenClaw exec 呼叫
如何限制 OpenClaw 只能執行 slurm-agent
```

不得新增 OpenClaw SDK dependency。

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
8. OpenClaw exec integration example
```
