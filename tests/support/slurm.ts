import type { Policy } from "../../src/policy/types.js";
import type {
  ArtifactDownload, RemoteExecutor, RemoteResult, SafeArtifactBundleTransfer,
  SafeArtifactTransfer, SafeCommand, SafeSubmissionUpload,
} from "../../src/transport/types.js";

export const testPolicy: Policy = {
  allowedPartitions: ["slurm-test"], maxNodes: 2, maxNtasks: 16, maxNtasksPerNode: 8, maxCpusPerTask: 8,
  maxMemoryGb: 64, maxGpus: 4, maxGpusPerNode: 4, maxGpusPerTask: 2, allowExclusive: true,
  maxTimeMinutes: 240, maxWaitSeconds: 3600,
  maxHistoryDays: 30, maxHistoryJobs: 200, maxListJobs: 200,
  maxInputFiles: 64, maxInputFileBytes: 104857600, maxInputTotalBytes: 536870912,
  maxArrayTasks: 1000, maxArrayConcurrency: 32, maxDependencyJobs: 16,
  allowedDependencyTypes: ["after", "afterany", "aftercorr", "afternotok", "afterok", "singleton"],
  allowedLaunchers: ["single", "srun"], allowedMpiModes: ["pmix"],
  allowedDistributions: ["block", "cyclic"],
  maxLogLines: 1000, maxLogBytes: 1024,
  maxArtifactBytes: 4096, maxArtifactFiles: 100, allowedSignals: ["TERM", "USR1"],
  allowedApptainerImages: { pytorch: "/opt/apptainer/pytorch.sif" },
  allowedVirtualenvs: { "project-a": "/opt/venvs/project-a" },
  allowedModules: { gcc: "gcc/12.2", cuda: "cuda/12.1" },
  allowedGres: { a100x1: "gpu:a100:1" },
  allowedAccounts: { research: "proj123" }, allowedQos: { normal: "normal" },
  allowedConstraints: { modern: "[zen3|zen4]" }, allowedNodelists: { "gpu-a": "gpu[01-02]" },
  allowedExcludeNodelists: { maintenance: "gpu[03,07-09]" },
  allowedReservations: { workshop: "ws2026" },
  maxScriptBytes: 65536, maxScriptArgs: 32, maxScriptArgLength: 1024,
  requireApptainerForGeneratedScripts: false,
};

export interface ExpectedRemoteResult {
  executable?: string;
  result: RemoteResult;
}

export class MockRemoteExecutor implements RemoteExecutor {
  readonly commands: SafeCommand[] = [];
  readonly downloads: SafeArtifactTransfer[] = [];
  readonly bundleDownloads: SafeArtifactBundleTransfer[] = [];
  readonly uploads: SafeSubmissionUpload[] = [];
  private readonly results: ExpectedRemoteResult[];

  constructor(results: Array<RemoteResult | ExpectedRemoteResult>) {
    this.results = results.map((entry) => "result" in entry ? entry : { result: entry });
  }

  async run(command: SafeCommand): Promise<RemoteResult> {
    this.commands.push(command);
    const expected = this.results.shift();
    if (!expected) throw new Error(`Unexpected remote command: ${command.executable}`);
    if (expected.executable && expected.executable !== command.executable) {
      throw new Error(`Expected remote command ${expected.executable}, received ${command.executable}`);
    }
    return expected.result;
  }

  async downloadArtifact(transfer: SafeArtifactTransfer): Promise<ArtifactDownload> {
    this.downloads.push(transfer);
    return { bytes: 5, sha256: "a".repeat(64), overwritten: transfer.overwrite === true };
  }

  async downloadArtifactBundle(transfer: SafeArtifactBundleTransfer): Promise<ArtifactDownload> {
    this.bundleDownloads.push(transfer);
    return { bytes: 11, sha256: "b".repeat(64), overwritten: transfer.overwrite === true };
  }

  async uploadSubmission(upload: SafeSubmissionUpload): Promise<{ bytes: number }> {
    this.uploads.push(upload);
    return { bytes: upload.content.length };
  }

  async close(): Promise<void> {}
}

export class FailingInputExecutor extends MockRemoteExecutor {
  override async uploadSubmission(upload: SafeSubmissionUpload): Promise<{ bytes: number }> {
    if (upload.label === "input") throw new Error("simulated input upload failure");
    return super.uploadSubmission(upload);
  }
}

export const ok = (stdout = "", stderr = ""): RemoteResult => ({ stdout, stderr, exitCode: 0 });

export const preparedScript = {
  content: Buffer.from("#!/bin/sh\necho ok\n"),
  relativePath: "jobs/test.sh",
  sha256: "abc123",
};
