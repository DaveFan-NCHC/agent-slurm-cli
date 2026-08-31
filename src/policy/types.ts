export interface Policy {
  allowedPartitions: string[];
  maxNodes: number;
  maxNtasks: number;
  maxCpusPerTask: number;
  maxMemoryGb: number;
  maxGpus: number;
  maxTimeMinutes: number;
  maxWaitSeconds: number;
  maxLogLines: number;
  maxLogBytes: number;
  maxArtifactBytes: number;
  allowedApptainerImages: Record<string, string>;
  allowedVirtualenvs: Record<string, string>;
  allowedGres: Record<string, string>;
  maxScriptBytes: number;
  maxScriptArgs: number;
  maxScriptArgLength: number;
  requireApptainerForGeneratedScripts: boolean;
}
