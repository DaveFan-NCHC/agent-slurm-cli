# Slurm Agent CLI：專案目標與 Roadmap

> 目前基準版本：`0.9.2`
>
> 文件更新日期：2026-10-08
>
> 專案狀態：下一階段五項 Priority 均已實作並通過本地測試；尚待部署 cluster 驗證。

## 1. 專案目標

`slurm-agent` 是供 Agent 透過 `exec` 呼叫的獨立 CLI。它透過已驗證的 SSH 連線操作遠端 Slurm cluster，提供安全、結構化、可稽核且受 policy 限制的 Slurm semantic operations。

核心架構：

```text
Agent
  │
  │ exec（只允許 slurm-agent）
  ▼
slurm-agent CLI
  ├── argument schema
  ├── validation / normalization
  ├── policy enforcement
  ├── path containment
  ├── job ownership checks
  └── audit logging
  │
  │ verified, controlled SSH/SFTP
  ▼
Slurm Login Node
  ├── fixed executable allowlist
  └── separately escaped arguments
  │
  ▼
Slurm Controller / Compute Nodes
```

`slurm-agent` 本身是 capability boundary，而不只是 Slurm commands 的方便包裝。

## 2. 核心設計原則

1. 只提供明確的 Slurm semantic operations，不提供任意遠端執行。
2. stdout 預設只輸出一個穩定、machine-readable 的 JSON object。
3. 所有輸入必須經過 parse、validate、normalize、policy check，再組成遠端命令。
4. 所有 job mutation 與敏感 job query 都必須限制在 configured SSH user 擁有的 jobs。
5. 檔案傳輸只能發生在 CLI 決定的受控路徑，不開放遠端檔案瀏覽器或任意來源/目的地。
6. 新功能若看似需要 generic SSH command，應設計成更窄的 Slurm-specific subcommand。
7. Slurm、SSH、accounting 或 optional plugin 不可用時，必須回傳明確的結構化錯誤或有定義的降級結果，不得猜測。

明確禁止的 public interface：

```text
slurm-agent exec ...
slurm-agent ssh ...
slurm-agent shell ...
slurm-agent command ...
generic SCP/SFTP browser
arbitrary remote path access
interactive remote terminal
```

## 3. 目前已完成的功能

### 3.1 CLI commands

目前 public interface：

```text
slurm-agent submit
slurm-agent policy
slurm-agent cluster-info
slurm-agent nodes
slurm-agent list
slurm-agent history
slurm-agent diagnose JOB_ID
slurm-agent fairshare
slurm-agent status JOB_ID
slurm-agent usage JOB_ID
slurm-agent cancel JOB_ID
slurm-agent hold JOB_ID
slurm-agent release JOB_ID
slurm-agent requeue JOB_ID
slurm-agent update JOB_ID
slurm-agent signal JOB_ID
slurm-agent logs JOB_ID
slurm-agent artifacts JOB_ID [--download [--prefix RELATIVE_DIRECTORY] [--force]]
slurm-agent artifact JOB_ID --path RELATIVE_PATH [--force]
slurm-agent wait JOB_ID
```

已完成的能力包括：

- read-only effective policy inspection；不提供 policy 修改介面。
- artifact 單檔與整包下載使用 SFTP，遠端／本地 SHA-256 驗證後才安裝；支援明確 `--force` 原子覆寫與受控 `--prefix` 子目錄打包。
- 受控 script staging 與 `sbatch` 提交。
- nodes、tasks、CPU、memory、GPU/GRES、walltime 等有界資源請求。
- account、QOS、constraint、nodelist、exclude、reservation 的 operator-defined aliases。
- job arrays、array concurrency 與受限 dependency types。
- submission-scoped input bundle，以及 backward-compatible `single` / policy-approved `srun` launcher。
- Apptainer、virtualenv 或 policy 允許的 host runtime。
- active queue、completed accounting history、單一 job status。
- bounded queue/history filters、job scheduling diagnosis，以及 node memory/GRES/feature availability。
- accounting/live resource usage、CPU/memory efficiency 與 fair-share 查詢。
- cancel、hold、release、requeue、受限 update 與受限 signal。
- bounded wait、bounded log tail、artifact listing 與單一檔案下載。
- stable JSON output、stable process exit codes 與 audit events。

### 3.2 Submit 的目前範圍

目前接受的主要 submission options：

```text
partition
nodes
ntasks
ntasks-per-node
cpus-per-task
mem / mem-per-cpu
gpus / gpus-per-node / gpus-per-task / gres alias
account / qos / constraint / nodelist / exclude / reservation aliases
exclusive
array
dependency
time
job-name
apptainer-image / venv
input files
launcher / mpi / distribution
script arguments
```

重要限制：

- `--launcher single` 維持只執行一次 payload；`--launcher srun` 才會依 validated task placement 啟動 job step。
- submission 可 staging policy-bounded inputs；它仍不是 generic file transfer。
- Apptainer MPI 的 PMI/PMIx ABI 與 plugin 相容性仍需由 operator 在部署 cluster 驗證。

### 3.3 Query 的目前範圍

- `list`：configured user 的 active jobs；支援 state、partition、name、account、limit、sort 與 array view。
- `status`：先查 `squeue`，離開 queue 後查 `sacct`。
- `history`：支援 bounded days 或明確時間窗，以及 state、partition、name、account、limit、sort 與 array view。
- `diagnose`：彙整 owned job 狀態、requested resources、pending reason 與可取得的 multifactor priority。
- `usage`：查 accounting steps，active job 可額外查 `sstat`。
- `fairshare`：查 configured user 的 `sshare` 資料。
- `cluster-info` / `nodes`：只查 policy 允許的 partitions；node 資料包含 state、CPU、memory、configured/used GRES、features 與 unavailable reason。

### 3.4 Lifecycle update 的目前範圍

`update` 只允許：

```text
time limit
dependency
array concurrency
```

它不是 generic `scontrol update` passthrough。

## 4. Security Boundary

### 4.1 Transport

- SSH command connection 與選用的 SFTP transfer connection 都必須驗證 host identity。
- 支援 pinned known_hosts 或 SHA256 fingerprint；沒有 insecure host-checking 模式。
- CLI caller 不能選擇任意 remote executable。
- 每個 remote argument 必須獨立 escape，禁止字串拼接 shell command。

### 4.2 Script 與路徑

Agent-generated script 必須：

- 位於 `SLURM_LOCAL_JOB_WORKSPACE` 下。
- 是 regular file，不可為 symlink。
- 是有效 UTF-8、有 shebang、大小受限。
- 不含 `#SBATCH` directives。
- 通過 argument count/length limits。

CLI 只會將 script 上傳至自行產生的：

```text
SLURM_REMOTE_WORKSPACE/.slurm-agent/submissions/<uuid>/
```

logs、inputs 與 artifacts 只能位於 CLI 管理的 submission/job-specific directories。所有 remote/local 路徑都必須做 canonicalization 與 containment check。

### 4.3 Workspace visibility

`SLURM_REMOTE_WORKSPACE` 必須由 login node 與 eligible compute nodes 以相同絕對路徑看見。Policy 中的 Apptainer image 與 virtualenv 也必須在相關節點提供相同內容。

以下只屬於執行 CLI 的機器，不需分享給 Slurm nodes：

```text
SLURM_LOCAL_JOB_WORKSPACE
SLURM_LOCAL_ARTIFACTS
SSH credentials
known_hosts
policy file
audit log
```

### 4.4 Ownership

以下操作必須在執行前驗證 job ownership：

```text
status, usage, wait, logs, artifacts, artifact
cancel, hold, release, requeue, update, signal
dependency references
diagnose
```

Array parent 與 explicit task ID 必須沿用現有一致語意；需要單一 task 資料時，不得默默選取任一 array task。

### 4.5 Output 與 audit

成功：

```json
{"ok":true,"job_id":"12345"}
```

失敗：

```json
{"ok":false,"error":{"code":"PARTITION_NOT_ALLOWED","message":"Partition gpu is not permitted."}}
```

Audit event 應包含 timestamp、action、SSH user、job ID、resource summary、policy decision、result 與 remote exit code；不得包含 password、private key、credential environment 或未處理的 remote stderr。

目前 exit-code contract：

```text
0 success
1 configuration or general failure
2 invalid arguments
3 policy/path denied
4 SSH/host-verification/timeout failure
5 Slurm operation failure
6 job/log/artifact not found
7 permission/ownership denied
```

## 5. 下一階段：五項優先功能與進度

這五項共同構成下一階段，不代表只挑其中一項。實作順序需考慮依賴，但 milestone 完成標準是五項全部完成。

目前進度：

```text
1. submission-scoped input bundle      已實作
2. safe parallel launcher              已實作
3. diagnose JOB_ID                     已實作
4. list/history filters                已實作
5. node memory/GPU availability        已實作
```

五項均已完成程式、policy、help、README、skill 與測試整合。本 milestone 的剩餘工作是實際部署 cluster 的 smoke/integration validation，不再有未實作 Priority。

## 6. Priority 1：Submission-scoped input bundle（已實作）

### 6.1 目的

原本 submission 只上傳 script；目前已新增受控 input staging，讓 job 可以攜帶程式碼、設定檔或小型輸入資料，但不開放 generic file transfer。

目標介面：

```bash
slurm-agent submit [resources] \
  --input inputs/config.yaml \
  --input src/model.py \
  jobs/train.sh
```

第一版採 repeatable `--input`，保留安全 relative path，不提供 caller-defined destination 或 archive 解壓縮。

### 6.2 路徑與 runtime contract

- 每個 input 都必須位於 `SLURM_LOCAL_JOB_WORKSPACE` 下。
- 禁止 absolute path、`..`、symlink、device、FIFO、socket 與 hard-link ambiguity。
- inputs 上傳到該次 UUID submission directory 的固定 `inputs/` 子目錄；每檔以 temporary file 加 atomic rename 完成。
- destination relative path 由安全的 local relative path 決定，caller 不可指定任意 remote path。
- payload 透過固定環境變數取得 input root，例如：

```text
SLURM_AGENT_INPUT_DIR
```

- Apptainer 將 input directory bind 到固定的唯讀 `/inputs`。
- host/venv runtime 取得 job-specific remote input directory，但不得取得 transfer API。由於 payload 與 staged files 使用同一個 Unix identity，host/venv 模式不具和 read-only container mount 相同的防竄改保證。
- array tasks 共用同一份 inputs。Apptainer 模式必須唯讀；host/venv 模式至少要避免 CLI 主動覆寫並清楚標示其非 sandbox 性質。

### 6.3 Policy

至少新增：

```yaml
max_input_files: 64
max_input_file_bytes: 104857600
max_input_total_bytes: 536870912
```

所有 limits 省略時預設為 `0`，因此 inputs fail closed。Allowlisted suffix、operator-defined dataset aliases 或 archive bundle 留待後續評估。

### 6.4 Output 與 audit

Submit response 可包含不洩漏 remote internals 的摘要：

```json
{
  "ok": true,
  "job_id": "12345",
  "inputs": {
    "files": 2,
    "bytes": 8421,
    "manifest_sha256": "..."
  }
}
```

Audit 記錄 file count、total bytes、manifest hash；預設不記錄檔案內容。

### 6.5 驗收重點

```text
single and multiple inputs
nested relative paths
duplicate destination rejection
missing file
absolute/traversal path
local symlink and special file rejection
per-file/count/total size limits
partial upload cleanup or safe unusable staging state
read-only Apptainer mount
array sharing semantics
manifest/hash stability
```

## 7. Priority 2：Safe parallel launcher（已實作）

### 7.1 目的

讓 `--ntasks` 不只配置資源，也能由 trusted runner 以明確模式啟動 Slurm job step，支援常見 MPI/多節點 workload，同時不提供 generic `srun` passthrough。

目標介面：

```bash
slurm-agent submit [resources] --launcher single jobs/train.sh
slurm-agent submit [resources] --launcher srun jobs/mpi.sh
```

`single` 保持目前語意且為預設值；即使 `ntasks > 1` 也不靜默改變既有 job 的執行次數。需要每 task 執行 payload 時必須明確指定 `--launcher srun`。

### 7.2 Launcher contract

- `single`：trusted runner 只執行一次 payload。
- `srun`：trusted runner 使用 operator-controlled `srun` executable 啟動 payload。
- caller 不能傳入任意 `srun` flags。
- task count、task placement、CPU/GPU binding 只能來自已驗證的 submit options 與 policy-defined enum/aliases。
- 第一版 MPI mode 只接受 policy allowlisted safe names，例如 `pmix` variants；不可接受 raw plugin flag 或任意 launcher argument。
- single-node、multi-node、array 與 dependency jobs 共用同一 launcher contract。

第一版 bounded options：

```text
--launcher single|srun
--mpi ALIAS
--distribution block|cyclic
```

CPU/GPU raw bind flags未公開；`cpus-per-task` 與可選的 `gpus-per-task` 由 validated submit resources 傳給 trusted `srun`。

### 7.3 Container integration

Apptainer 模式採用以下架構：

1. host `srun` 啟動每個 task，再由每個 task 進入 Apptainer。

`srun` executable 由 trusted `SLURM_REMOTE_SRUN_PATH` 決定，不假設 image 內有 `srun`。若 payload 本身使用 MPI，image 內 PMI/PMIx ABI/plugin 相容性仍由 operator 驗證。

### 7.4 Policy

至少需要明確表達：

```yaml
allowed_launchers: [single, srun]
allowed_mpi_modes: [pmix]
allowed_distributions: [block, cyclic]
```

`allowed_launchers` 省略時預設只有 `single`；MPI modes 與 distributions 省略時預設停用。

### 7.5 驗收重點

```text
single launcher backward compatibility
srun launches the requested number of tasks
single-node and multi-node placement
cpus-per-task propagation
GPU-per-task behavior
array task behavior
host, venv and Apptainer runtime behavior
MPI mode allowlist
rejection of arbitrary launcher flags
signal, cancel and exit-code propagation
logs and artifacts under multiple ranks
partial task failure behavior
```

多 rank artifact 使用 `ranks/<SLURM_PROCID>/` 子目錄避免互相覆寫，且 caller 無法逃離 job artifact root。

## 8. Priority 3：`diagnose JOB_ID`（已實作）

### 8.1 目的

新增：

```bash
slurm-agent diagnose JOB_ID
```

用結構化資料回答：

- job 為什麼還在等待？
- 是否被 dependency、begin time、priority、resource、account/QOS limit 或 constraint 阻擋？
- Slurm 是否提供預估開始時間？
- job 實際要求哪些 scheduling resources？
- 使用 multifactor priority 時，各 priority factors 的貢獻為何？

它不是任意 `scontrol`/`sprio` passthrough，也不得回傳未解析的完整 Slurm output。

### 8.2 資料來源

使用最少量的 bounded read-only queries：

1. 既有 `squeue` / `sacct` lookup：確認 job、ownership 與基本狀態。
2. `scontrol show job JOB_ID`：取得 dependency、eligible/begin time、requested resources 與 scheduling fields。
3. `sprio --jobs=JOB_ID`：pending 且使用 multifactor priority 時取得 priority factors。

新增 `sprio` 前必須加入 internal executable allowlist；caller 不可選擇任何 `sprio` flags。

### 8.3 JSON contract

目標輸出形狀：

```json
{
  "ok": true,
  "job_id": "12345",
  "job": {
    "state": "PENDING",
    "reason": "Priority",
    "partition": "gpu",
    "eligible_time": "2026-10-08T09:00:00",
    "expected_start_time": "2026-10-08T18:30:00",
    "dependency": null
  },
  "requested_resources": {
    "nodes": 1,
    "cpus": 8,
    "memory": "32G",
    "tres": "cpu=8,mem=32G,gres/gpu=1"
  },
  "priority": {
    "available": true,
    "total": 48321,
    "age": 1200,
    "association": 0,
    "fairshare": 35100,
    "job_size": 21,
    "partition": 12000,
    "qos": 0,
    "tres": "0",
    "nice": 0
  },
  "findings": [
    {
      "code": "WAITING_FOR_PRIORITY",
      "message": "The job is eligible and is waiting behind higher-priority work."
    }
  ]
}
```

Contract rules：

- 保留 Slurm normalized `state` 與原始 `reason`。
- 無法取得的 optional fields 應省略或使用明確的 `available: false`，不得製造數值。
- `findings[].code` 必須穩定；分類只能根據 Slurm 已回報資料。
- Slurm 未提供 estimate 時省略 `expected_start_time`。
- priority plugin 未啟用、`sprio` 不支援或 job 不再 pending 時，回傳 `priority.available: false`，不讓整個 diagnose 失敗。
- ownership、主要 job lookup 或必要 query 失敗時，使用既有 stable error contract。

第一版 finding codes 至少包含：

```text
DEPENDENCY_BLOCKED
BEGIN_TIME_NOT_REACHED
WAITING_FOR_PRIORITY
WAITING_FOR_RESOURCES
UNSATISFIABLE_CONSTRAINT
ACCOUNT_OR_QOS_LIMIT
JOB_RUNNING
JOB_COMPLETED
JOB_FAILED
UNKNOWN_PENDING_REASON
```

### 8.4 驗收重點

```text
pending Priority / Resources / Dependency / BeginTime
account or QOS limit
bad constraint
running, completed and failed jobs
sprio unavailable, empty or malformed
multifactor priority parsing
foreign-owned job
array parent and explicit task ID
invalid/injected job ID
truncated remote output
stable findings and audit behavior
```

## 9. Priority 4：`list` / `history` filters（已實作）

### 9.1 目的

讓使用者能在大量 jobs 中取得相關結果，不必下載整份 queue/history 後自行過濾，也避免無界 accounting queries。

目標介面：

```bash
slurm-agent list --state PENDING --partition gpu --name train --limit 50
slurm-agent history --since 2026-10-01T00:00:00 --until 2026-10-08T00:00:00 \
  --state FAILED --partition gpu --name train --limit 100
```

實際名稱需維持簡潔且和既有 `--days` 相容。

### 9.2 第一版 filters

`list`：

```text
state
partition alias
job-name exact match
account alias
limit
sort enum
array view: expanded|summary
```

`history`：

```text
days 或 since/until（互斥）
state（bounded comma-separated list）
partition alias
job-name exact match
account alias
limit
sort enum
```

所有 scheduler selectors 必須沿用 policy aliases；不得接受 raw partition/account 值繞過 policy。

### 9.3 Query 與 limit contract

- 所有 queries 固定為 configured SSH user。
- server-side filter 能安全表達時優先使用，否則在 bounded result 上 local filter。
- `limit` 不只限制最後輸出，也要配合固定 byte cap，避免先抓取無界資料。
- `since/until` 必須使用嚴格 ISO-like grammar、明確 timezone contract，並受最大 history window 限制。
- 第一版時間格式固定為 cluster-local `YYYY-MM-DDTHH:MM:SS`，不接受 timezone suffix；由遠端 Slurm 依 cluster timezone 解讀。
- sort 只接受 enum，例如 `submit_time_desc`、`start_time_desc`、`priority_desc`；不可傳 raw Slurm format/sort expression。
- array summary 必須定義 aggregate state/count，不得因 task expansion 造成無界輸出。

### 9.4 Response contract

回傳 normalized query，讓 Agent 知道實際套用的範圍：

```json
{
  "ok": true,
  "query": {
    "states": ["FAILED"],
    "partition": "gpu",
    "since": "2026-10-01T00:00:00",
    "until": "2026-10-08T00:00:00",
    "limit": 100,
    "sort": "start_time_desc",
    "array_view": "summary"
  },
  "jobs": []
}
```

### 9.5 驗收重點

```text
each filter independently and combined
policy alias resolution
days versus since/until conflicts
timezone boundary
state validation
name/control-character injection
sort allowlist
limit and output-byte cap
array expanded/summary behavior
no cross-user rows
malformed and truncated output
```

## 10. Priority 5：Node memory/GPU availability（已實作）

### 10.1 目的

擴充 `nodes` 與必要的 `cluster-info`，讓使用者在提交前能判斷 policy-allowed nodes 上的 memory、GPU/GRES、feature 與不可用原因，而不只看到 configured CPU/GRES。

目標介面：

```bash
slurm-agent nodes
slurm-agent nodes --partition gpu --state idle --feature zen4-only
```

第一版已納入 partition alias、strict state enum 與單一 feature alias filters；回傳欄位涵蓋本 priority 的必要範圍。

### 10.2 Node fields

至少新增：

```text
memory.total_mib
memory.allocated_mib（cluster 有資料時）
memory.free_mib（informational，cluster 有資料時）
gres_configured
gres_used
features
active_features
reason
reason_time（可取得時）
temporary_disk_mib（可取得時）
```

既有 CPU state 與 node state 欄位保持相容。

### 10.3 語意要求

- `free_mib` 是 node OS 回報的即時資訊，不等同 scheduler 可配置 memory；欄位或文件必須清楚標示 informational。
- `gres_configured` 與 `gres_used` 必須分離，不能以字串相減推導錯誤的 GPU availability。
- 若能可靠解析 typed GPU totals/used，可額外提供 normalized summary；無法可靠解析時保留 bounded raw GRES tokens。
- node reason 只能來自 Slurm，不自行推測硬體故障原因。
- 只查 policy 允許的 partitions；重複出現在多個 partitions 的 node 必須有穩定表示方式。
- filters 使用 partition/feature aliases 或 strict enum，不接受 raw Slurm expressions。

### 10.4 Response example

```json
{
  "ok": true,
  "nodes": [
    {
      "node_name": "gpu01",
      "partition": "gpu",
      "state": "mixed",
      "cpus": {"allocated": 32, "idle": 32, "other": 0, "total": 64},
      "memory": {
        "total_mib": 515000,
        "allocated_mib": 257500,
        "free_mib": 241000,
        "free_is_informational": true
      },
      "gres_configured": ["gpu:a100:4"],
      "gres_used": ["gpu:a100:2"],
      "features": ["zen4", "a100"],
      "active_features": ["zen4", "a100"]
    }
  ]
}
```

### 10.5 驗收重點

```text
memory and GRES parsing
missing/unknown/free-memory values
mixed, drained and down nodes
drain reason sanitization
configured versus used GRES
multiple GRES types
node in multiple partitions
partition/state/feature filters
policy partition containment
large cluster output cap
malformed and truncated output
```

## 11. 五項功能的共同 Definition of Done

下一階段完成時，必須全部滿足：

- 五項 public contracts、help 與 README 已同步。
- policy schema、example policy 與 unknown-key fail-closed behavior 已更新。
- command handlers、Slurm client、types、parsers 與 transport allowlist 維持分層。
- 新增 output fields 和 errors 有穩定 machine-readable contract。
- 所有 remote calls 都使用 typed `SafeCommand`、固定 executable 與獨立 escaped arguments。
- input、launcher、query filters 與 node filters 都有明確 limits。
- ownership、path containment、argument injection、malformed output、truncation 與 policy denial 都有測試。
- array、Apptainer、venv、host runtime 的相關語意已文件化並測試。
- audit events 不包含檔案內容、credentials 或 raw remote output。
- 以下全部通過：

```bash
npm run typecheck
npm test
npm run build
```

## 12. 後續 Roadmap

五項優先功能完成後再評估：

- scheduled/checkpointable submission：begin、deadline、pre-time-limit signal、requeue preference。
- additional HPC resources：mem/cpus/ntasks per GPU、threads/core、hint、local scratch、license aliases。
- bounded log follow 與 array log aggregation。
- account/project allocation 與 TRES usage reports。
- submission manifest、provenance 與安全的 clone/resubmit。
- operator-defined、短時間且無 interactive shell 的 debug-job templates。

## 13. Non-goals

除非安全模型與部署方式有重大改變，以下維持 non-goals：

```text
generic SSH client or shell
interactive salloc / srun --pty / sattach
remote terminal or port forwarding
generic SCP/SFTP browser
arbitrary local or remote file paths
sudo
sacctmgr mutation
node/partition administration
unbounded cluster-wide queries
caller-defined remote executable or raw command flags
```

## 14. Development 與部署原則

每個新功能都應：

1. 先定義 CLI 與 JSON contract。
2. 在 policy/types 中明確表達限制。
3. 使用 typed `SafeCommand`，不接受 raw command string。
4. 對 parser 加入正常、空值、malformed、truncated output 測試。
5. 對 ownership、path containment、argument injection 與 output limits 加入 security tests。
6. 更新 README、help text、skill instructions 與 example policy。
7. 不以支援所有 Slurm flags 為目標；只加入需求明確、可受 policy 控制的 semantic capability。

Production 應安裝固定版本，Agent runtime 只允許執行已安裝的 `slurm-agent`，不允許使用 `npm`、`npx`、`node`、`ssh` 或 shell 作為替代執行路徑。

## 15. 專案完成標準

- 常用 batch lifecycle 能以明確、穩定的 semantic commands 完成。
- Agent 能取得足夠的狀態、診斷、resource availability、usage、logs 與 artifacts 來做可靠決策。
- 單節點與 policy-approved 多 task/multi-node workloads 有明確且可驗證的 launch semantics。
- Job inputs 與 outputs 都有受控、bounded、可稽核的資料路徑。
- Operator 能以 policy 限制 partition、resources、runtime、launcher、scheduler selectors 與資料範圍。
- 所有 mutation 與敏感讀取都有 ownership validation 與 audit trail。
- 任意 shell、任意 SSH command、任意 path 與任意 transfer 始終不可由 Agent 取得。
- 新增功能不削弱既有 capability boundary。
