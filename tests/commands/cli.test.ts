import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";

class Sink {
  value = "";
  write(chunk: string | Uint8Array): boolean { this.value += chunk.toString(); return true; }
}

describe("CLI boundary", () => {
  it.each(["exec", "ssh", "shell", "run", "command"])("does not expose %s", async (command) => {
    const stdout = new Sink();
    const stderr = new Sink();
    const code = await main([command, "id"], {}, stdout, stderr as never);
    expect(code).toBe(2);
    expect(JSON.parse(stdout.value)).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
  });
  it("prints help without loading credentials", async () => {
    const stdout = new Sink();
    expect(await main(["--help"], {}, stdout)).toBe(0);
    expect(stdout.value).toContain("slurm-agent submit");
  });
  it.each([
    ["submit", "--script", "jobs/a.sh", "--partition", "p", "--export", "ALL"],
    ["cancel", "1", "--user", "all"],
    ["list", "--partition", "gpu"],
    ["logs", "1", "--path", "/etc/passwd"],
    ["artifact", "1", "--output", "/etc/passwd"],
    ["artifact", "1", "--path", "../../etc/passwd", "--overwrite", "true"],
  ])("rejects unexpected command options before loading credentials", async (...argv) => {
    const stdout = new Sink();
    const code = await main(argv, {}, stdout);
    expect(code).toBe(2);
    expect(JSON.parse(stdout.value)).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
  });
});
