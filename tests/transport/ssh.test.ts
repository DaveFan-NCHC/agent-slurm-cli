import { describe, expect, it, vi } from "vitest";
import type { ConnectConfig } from "ssh2";

const captured = vi.hoisted(() => ({ connection: undefined as ConnectConfig | undefined }));

vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");
  class MockChannel extends EventEmitter {
    readonly stderr = new EventEmitter();
    close(): void {}
  }

  class MockClient extends EventEmitter {
    connect(connection: ConnectConfig): this {
      captured.connection = connection;
      queueMicrotask(() => this.emit("ready"));
      return this;
    }

    exec(_command: string, callback: (error: undefined, channel: MockChannel) => void): void {
      const channel = new MockChannel();
      callback(undefined, channel);
      queueMicrotask(() => channel.emit("close", 0, undefined));
    }

    end(): void { this.emit("close"); }
  }

  return { Client: MockClient };
});

import { SshExecutor } from "../../src/transport/ssh.js";

describe("SSH authentication", () => {
  it("passes only the configured password to ssh2", async () => {
    const executor = new SshExecutor({
      host: "login.example",
      port: 22,
      user: "alice",
      authentication: { type: "password", password: "test password" },
      hostFingerprint: "SHA256:test",
      workspace: "/work",
      timeoutMs: 30000,
    });

    await executor.run({ executable: "squeue", args: [] });

    expect(captured.connection).toMatchObject({
      host: "login.example",
      port: 22,
      username: "alice",
      password: "test password",
    });
    expect(captured.connection?.privateKey).toBeUndefined();
    await executor.close();
  });
});
