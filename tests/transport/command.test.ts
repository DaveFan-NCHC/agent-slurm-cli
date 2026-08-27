import { describe, expect, it } from "vitest";
import { renderCommand, shellEscape } from "../../src/transport/types.js";

describe("remote command rendering", () => {
  it("quotes every executable and argument", () => {
    expect(renderCommand({ executable: "sbatch", args: ["--job-name=a b", "x'y", "; id"] }))
      .toBe("'sbatch' '--job-name=a b' 'x'\"'\"'y' '; id'");
  });
  it.each(["a\nb", "a\rb", "a\0b"])("rejects control characters", (value) => {
    expect(() => shellEscape(value)).toThrow();
  });
});
