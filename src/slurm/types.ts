export interface JobSummary {
  job_id: string;
  name: string;
  partition: string;
  state: string;
  elapsed: string;
  exit_code?: string;
  reason?: string;
  priority?: number;
  start_time?: string;
  submit_time?: string;
  time_limit?: string;
  time_left?: string;
  node_list?: string;
  nodes?: number;
  cpus?: number;
  account?: string;
  qos?: string;
  reservation?: string;
}

export interface OwnedJob extends JobSummary {
  user: string;
}

export interface LogResult {
  job_id: string;
  stream: "stdout" | "stderr";
  content: string;
  truncated: boolean;
}

export interface ArtifactResult {
  job_id: string;
  remote_path: string;
  local_path: string;
  bytes: number;
}

export interface ArtifactEntry {
  path: string;
  bytes: number;
}

export interface FairShareEntry {
  account: string;
  user: string;
  raw_shares: string;
  normalized_shares: string;
  raw_usage: string;
  effective_usage: string;
  fair_share: string;
  level_fair_share: string;
  group_tres_minutes: string;
  tres_run_minutes: string;
}

export interface PartitionInfo {
  partition: string;
  availability: string;
  time_limit: string;
  node_state: string;
  nodes: number;
  cpus: {
    allocated: number;
    idle: number;
    other: number;
    total: number;
  };
  gres: string[];
}

export interface NodeInfo {
  node_name: string;
  partition: string;
  availability: string;
  state: string;
  cpus: {
    allocated: number;
    idle: number;
    other: number;
    total: number;
  };
  gres: string[];
  memory: {
    total_mib: number;
    allocated_mib?: number;
    free_mib?: number;
    free_is_informational?: true;
  };
  gres_configured: string[];
  gres_used: string[];
  features: string[];
  active_features: string[];
  reason?: string;
  reason_time?: string;
  temporary_disk_mib?: number;
}

export type JobSort = "submit_time_desc" | "start_time_desc" | "priority_desc" | "job_id_asc";
export type HistorySort = "start_time_desc" | "end_time_desc" | "job_id_asc";
export type ArrayView = "expanded" | "summary";

export interface ListQuery {
  states?: string[];
  partition?: string;
  name?: string;
  account?: string;
  limit: number;
  sort: JobSort;
  array_view: ArrayView;
}

export interface HistoryQuery {
  days?: number;
  since?: string;
  until?: string;
  states?: string[];
  partition?: string;
  name?: string;
  account?: string;
  limit: number;
  sort: HistorySort;
  array_view: ArrayView;
}

export interface NodeQuery {
  partition?: string;
  state?: string;
  feature?: string;
}

export interface RequestedResources {
  nodes?: number;
  cpus?: number;
  memory?: string;
  tres?: string;
}

export interface PriorityFactors {
  available: boolean;
  total?: number;
  age?: number;
  association?: number;
  fairshare?: number;
  job_size?: number;
  partition?: number;
  qos?: number;
  tres?: string;
  nice?: number;
  site?: number;
}

export type DiagnosisCode =
  | "DEPENDENCY_BLOCKED"
  | "BEGIN_TIME_NOT_REACHED"
  | "WAITING_FOR_PRIORITY"
  | "WAITING_FOR_RESOURCES"
  | "UNSATISFIABLE_CONSTRAINT"
  | "ACCOUNT_OR_QOS_LIMIT"
  | "JOB_RUNNING"
  | "JOB_COMPLETED"
  | "JOB_FAILED"
  | "UNKNOWN_PENDING_REASON";

export interface DiagnosisFinding {
  code: DiagnosisCode;
  message: string;
}

export interface JobDiagnosis {
  job_id: string;
  job: Omit<OwnedJob, "user"> & {
    eligible_time?: string;
    expected_start_time?: string;
    dependency?: string;
  };
  requested_resources: RequestedResources;
  priority: PriorityFactors;
  findings: DiagnosisFinding[];
}

export interface WaitResult {
  job: OwnedJob;
  terminal: boolean;
  timed_out: boolean;
}

export interface HistoryJob {
  job_id: string;
  name: string;
  partition: string;
  state: string;
  elapsed: string;
  start: string;
  end: string;
  exit_code: string;
  allocated_cpus: number;
  allocated_nodes: number;
  requested_memory: string;
  requested_tres: string;
}

export interface OwnedHistoryJob extends HistoryJob {
  user: string;
}

export interface UsageStep {
  step_id: string;
  state?: string;
  elapsed?: string;
  elapsed_seconds?: number;
  total_cpu?: string;
  average_cpu?: string;
  max_rss?: string;
  max_vm_size?: string;
  max_disk_read?: string;
  max_disk_write?: string;
  allocated_tres?: string;
}

export interface JobUsage {
  job_id: string;
  name: string;
  partition: string;
  state: string;
  elapsed: string;
  elapsed_seconds: number;
  allocated_cpus: number;
  allocated_nodes: number;
  requested_memory: string;
  requested_tres: string;
  allocated_tres: string;
  total_cpu: string;
  max_rss: string;
  max_vm_size: string;
  max_disk_read: string;
  max_disk_write: string;
  exit_code: string;
  cpu_efficiency_percent?: number;
  memory_efficiency_percent?: number;
  steps: UsageStep[];
  live_available: boolean;
  live_steps: UsageStep[];
}
