import type {
  ArtifactDownload, RemoteExecutor, RemoteResult, SafeArtifactBundleTransfer,
  SafeCommand, SafeSubmissionUpload,
} from "../../src/transport/types.js";

export class Sink {
  value = "";
  write(chunk: string | Uint8Array): boolean { this.value += chunk.toString(); return true; }
}

export class SubmitExecutor implements RemoteExecutor {
  readonly commands: SafeCommand[] = [];
  readonly uploads: SafeSubmissionUpload[] = [];
  private readonly results: RemoteResult[];

  constructor(submitResult: RemoteResult = { stdout: "12345\n", stderr: "", exitCode: 0 }) {
    this.results = [
      { stdout: "/work\n", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "/work/.slurm-agent/logs\n", stderr: "", exitCode: 0 },
      { stdout: "/work/.slurm-agent/artifacts\n", stderr: "", exitCode: 0 },
      { stdout: "/work/.slurm-agent/submissions/staged\n", stderr: "", exitCode: 0 },
      submitResult,
    ];
  }

  async run(command: SafeCommand): Promise<RemoteResult> {
    this.commands.push(command);
    const result = this.results.shift();
    if (!result) throw new Error(`Unexpected remote command: ${command.executable}`);
    return result;
  }

  async uploadSubmission(upload: SafeSubmissionUpload): Promise<{ bytes: number }> {
    this.uploads.push(upload);
    return { bytes: upload.content.length };
  }

  async downloadArtifact(): Promise<ArtifactDownload> { return { bytes: 0, sha256: "a".repeat(64), overwritten: false }; }
  async downloadArtifactBundle(): Promise<ArtifactDownload> { return { bytes: 0, sha256: "b".repeat(64), overwritten: false }; }
  async close(): Promise<void> {}
}

export class QueryExecutor implements RemoteExecutor {
  readonly commands: SafeCommand[] = [];
  readonly bundleDownloads: SafeArtifactBundleTransfer[] = [];

  constructor(private readonly results: RemoteResult[]) {}

  async run(command: SafeCommand): Promise<RemoteResult> {
    this.commands.push(command);
    const result = this.results.shift();
    if (!result) throw new Error(`Unexpected remote command: ${command.executable}`);
    return result;
  }

  async uploadSubmission(): Promise<{ bytes: number }> { return { bytes: 0 }; }
  async downloadArtifact(): Promise<ArtifactDownload> { return { bytes: 0, sha256: "a".repeat(64), overwritten: false }; }
  async downloadArtifactBundle(transfer: SafeArtifactBundleTransfer): Promise<ArtifactDownload> {
    this.bundleDownloads.push(transfer);
    return { bytes: 123, sha256: "b".repeat(64), overwritten: transfer.overwrite === true };
  }
  async close(): Promise<void> {}
}
