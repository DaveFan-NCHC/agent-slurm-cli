export interface Policy {
  allowedPartitions: string[];
  maxNodes: number;
  maxNtasks: number;
  maxCpusPerTask: number;
  maxMemoryGb: number;
  maxTimeMinutes: number;
  maxLogLines: number;
  maxLogBytes: number;
  maxArtifactBytes: number;
  allowedApptainerImages: Record<string, string>;
  allowedVirtualenvs: Record<string, string>;
}
