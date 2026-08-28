import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { renderCommand, shellEscape } from "../../src/transport/types.js";

describe("remote command rendering", () => {
  it("quotes every executable and argument", () => {
    expect(renderCommand({ executable: "sbatch", args: ["--job-name=a b", "x'y", "; id"] }))
      .toBe("'sbatch' '--job-name=a b' 'x'\"'\"'y' '; id'");
  });
  it.each(["a\nb", "a\rb", "a\0b"])("rejects control characters", (value) => {
    expect(() => shellEscape(value)).toThrow();
  });
  it("renders a regular-file test accepted by the remote Bash shell", () => {
    const command = renderCommand({ executable: "test", args: ["-f", process.execPath] });
    const result = spawnSync("/bin/bash", ["-c", command], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(command).not.toContain("'--'");
  });
});
