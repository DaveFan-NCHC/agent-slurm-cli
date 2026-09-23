import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectConfig } from "ssh2";

const captured = vi.hoisted(() => ({
  connection: undefined as ConnectConfig | undefined,
  authMethods: [] as string[],
  interactivePromptCount: 0,
  interactivePromptEcho: false,
  replies: [] as string[][],
  completeAfterPrimary: false,
}));

vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");
  class MockChannel extends EventEmitter {
    readonly stderr = new EventEmitter();
    close(): void {}
  }

  class MockClient extends EventEmitter {
    connect(connection: ConnectConfig): this {
      captured.connection = connection;
      if (typeof connection.authHandler !== "function") {
        queueMicrotask(() => this.emit("ready"));
        return this;
      }
      const record = (method: unknown): string => {
        const type = typeof method === "string"
          ? method
          : typeof method === "object" && method !== null && "type" in method
            ? String(method.type)
            : String(method);
        captured.authMethods.push(type);
        return type;
      };
      const interactive = (complete: () => void): void => {
        if (captured.interactivePromptCount === 0) {
          complete();
          return;
        }
        const prompts = Array.from(
          { length: captured.interactivePromptCount },
          () => ({ prompt: "Password: ", echo: captured.interactivePromptEcho }),
        );
        this.emit("keyboard-interactive", "SSH", "", "", prompts, (replies: string[]) => {
          captured.replies.push(replies);
          queueMicrotask(complete);
        });
      };
      queueMicrotask(() => {
        connection.authHandler!([], false, (first) => {
          const firstType = record(first);
          if (captured.completeAfterPrimary) {
            this.emit("ready");
            return;
          }
          if (firstType === "keyboard-interactive") {
            interactive(() => this.emit("ready"));
            return;
          }
          connection.authHandler!(["keyboard-interactive"], true, (second) => {
            if (record(second) !== "keyboard-interactive") return;
            interactive(() => this.emit("ready"));
          });
        });
      });
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
  beforeEach(() => {
    captured.connection = undefined;
    captured.authMethods = [];
    captured.interactivePromptCount = 0;
    captured.interactivePromptEcho = false;
    captured.replies = [];
    captured.completeAfterPrimary = false;
  });

  it("passes only the configured password to ssh2", async () => {
    const executor = new SshExecutor({
      host: "login.example",
      port: 22,
      user: "alice",
      authentication: { type: "password", password: "test password" },
      hostFingerprint: "SHA256:test",
      workspace: "/work",
      timeoutMs: 30000,
      readyTimeoutMs: 30000,
      pushAuthentication: false,
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

  it("waits for zero-prompt keyboard-interactive push approval after the primary method", async () => {
    const executor = new SshExecutor({
      host: "login.example",
      port: 22,
      user: "alice",
      authentication: { type: "password", password: "test password" },
      hostFingerprint: "SHA256:test",
      workspace: "/work",
      timeoutMs: 30000,
      readyTimeoutMs: 120000,
      pushAuthentication: true,
    });

    await executor.run({ executable: "squeue", args: [] });

    expect(captured.connection).toMatchObject({
      tryKeyboard: true,
      readyTimeout: 120000,
    });
    expect(captured.authMethods).toEqual(["password", "keyboard-interactive"]);
    await executor.close();
  });

  it("rejects push authentication if the server requests interactive input", async () => {
    captured.interactivePromptCount = 1;
    const executor = new SshExecutor({
      host: "login.example",
      port: 22,
      user: "alice",
      authentication: { type: "password", password: "test password" },
      hostFingerprint: "SHA256:test",
      workspace: "/work",
      timeoutMs: 30000,
      readyTimeoutMs: 120000,
      pushAuthentication: true,
    });

    await expect(executor.run({ executable: "squeue", args: [] }))
      .rejects.toMatchObject({ code: "SSH_AUTH_FAILED" });
  });

  it("rejects a primary-only success when push approval is required", async () => {
    captured.completeAfterPrimary = true;
    const executor = new SshExecutor({
      host: "login.example",
      port: 22,
      user: "alice",
      authentication: { type: "password", password: "test password" },
      hostFingerprint: "SHA256:test",
      workspace: "/work",
      timeoutMs: 30000,
      readyTimeoutMs: 120000,
      pushAuthentication: true,
    });

    await expect(executor.run({ executable: "squeue", args: [] }))
      .rejects.toMatchObject({ code: "SSH_AUTH_FAILED" });
  });

  it("answers one hidden PAM keyboard-interactive password prompt", async () => {
    captured.interactivePromptCount = 1;
    const executor = new SshExecutor({
      host: "login.example",
      port: 22,
      user: "alice",
      authentication: { type: "keyboard-interactive-password", password: "pam password" },
      hostFingerprint: "SHA256:test",
      workspace: "/work",
      timeoutMs: 30000,
      readyTimeoutMs: 30000,
      pushAuthentication: false,
    });

    await executor.run({ executable: "squeue", args: [] });

    expect(captured.authMethods).toEqual(["keyboard-interactive"]);
    expect(captured.connection?.password).toBeUndefined();
    expect(captured.replies).toEqual([["pam password"]]);
    await executor.close();
  });

  it("waits for automatic push completion after answering the PAM password prompt", async () => {
    captured.interactivePromptCount = 1;
    const executor = new SshExecutor({
      host: "login.example",
      port: 22,
      user: "alice",
      authentication: { type: "keyboard-interactive-password", password: "pam password" },
      hostFingerprint: "SHA256:test",
      workspace: "/work",
      timeoutMs: 30000,
      readyTimeoutMs: 120000,
      pushAuthentication: true,
    });

    await executor.run({ executable: "squeue", args: [] });

    expect(captured.connection).toMatchObject({ tryKeyboard: true, readyTimeout: 120000 });
    expect(captured.replies).toEqual([["pam password"]]);
    await executor.close();
  });

  it.each([
    [2, false],
    [1, true],
  ])("rejects unsupported PAM prompt shape", async (promptCount, echo) => {
    captured.interactivePromptCount = promptCount;
    captured.interactivePromptEcho = echo;
    const executor = new SshExecutor({
      host: "login.example",
      port: 22,
      user: "alice",
      authentication: { type: "keyboard-interactive-password", password: "pam password" },
      hostFingerprint: "SHA256:test",
      workspace: "/work",
      timeoutMs: 30000,
      readyTimeoutMs: 30000,
      pushAuthentication: false,
    });

    await expect(executor.run({ executable: "squeue", args: [] }))
      .rejects.toMatchObject({ code: "SSH_AUTH_FAILED" });
  });
});
