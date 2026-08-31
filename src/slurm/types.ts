export interface JobSummary {
  job_id: string;
  name: string;
  partition: string;
  state: string;
  elapsed: string;
  exit_code?: string;
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
