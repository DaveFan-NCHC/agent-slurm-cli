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
