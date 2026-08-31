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
