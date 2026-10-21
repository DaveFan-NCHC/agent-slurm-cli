import { runSessionWorker, type SessionWorkerExecutor } from "../../src/session/worker.js";
import type {
  ArtifactDownload, RemoteResult, SafeArtifactBundleTransfer, SafeArtifactTransfer,
  SafeCommand, SafeSubmissionUpload,
} from "../../src/transport/types.js";

class ProcessFakeExecutor implements SessionWorkerExecutor {
  private connected = false;

  connectionStatus(): { command: boolean; transfer: boolean | "shared" } {
    return { command: this.connected, transfer: "shared" };
  }
  isConnected(): boolean { return this.connected; }
  async open(): Promise<void> { this.connected = true; }
  preventReconnect(): void {}
  async run(command: SafeCommand): Promise<RemoteResult> {
    return { stdout: `${command.executable}\n`, stderr: "", exitCode: 0 };
  }
  async downloadArtifact(_transfer: SafeArtifactTransfer): Promise<ArtifactDownload> {
    return { bytes: 1, sha256: "a".repeat(64), overwritten: false };
  }
  async downloadArtifactBundle(_transfer: SafeArtifactBundleTransfer): Promise<ArtifactDownload> {
    return { bytes: 2, sha256: "b".repeat(64), overwritten: false };
  }
  async uploadSubmission(upload: SafeSubmissionUpload): Promise<{ bytes: number }> {
    return { bytes: upload.content.length };
  }
  async close(): Promise<void> { this.connected = false; }
}

await runSessionWorker({ createExecutor: () => new ProcessFakeExecutor() });
