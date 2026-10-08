import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareInputBundle } from "../../src/policy/input.js";
import type { Policy } from "../../src/policy/types.js";

const policy = {
  maxInputFiles: 3,
  maxInputFileBytes: 8,
  maxInputTotalBytes: 12,
} as Policy;

describe("submission input bundles", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "slurm-agent-inputs-"));
    mkdirSync(join(workspace, "config"));
    mkdirSync(join(workspace, "src"));
  });

  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("prepares nested binary inputs with a stable sorted manifest", () => {
    writeFileSync(join(workspace, "config", "run.bin"), Buffer.from([0, 1, 2]));
    writeFileSync(join(workspace, "src", "model.py"), "model");
    const first = prepareInputBundle(workspace, ["src/model.py", "config/run.bin"], policy);
    const second = prepareInputBundle(workspace, ["config/run.bin", "src/model.py"], policy);

    expect(first.files.map((file) => file.relativePath)).toEqual(["config/run.bin", "src/model.py"]);
    expect(first.totalBytes).toBe(8);
    expect(first.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifestSha256).toBe(second.manifestSha256);
    expect(JSON.parse(first.manifest.toString("utf8"))).toMatchObject({
      version: 1,
      files: [
        { path: "config/run.bin", bytes: 3 },
        { path: "src/model.py", bytes: 5 },
      ],
    });
  });

  it.each(["/etc/passwd", "../secret", "src/../secret", "src/a;id"])(
    "rejects unsafe input path %j",
    (path) => expect(() => prepareInputBundle(workspace, [path], policy)).toThrowError(
      expect.objectContaining({ code: "LOCAL_PATH_NOT_ALLOWED" }),
    ),
  );

  it("rejects duplicate destinations and missing files", () => {
    writeFileSync(join(workspace, "src", "model.py"), "model");
    expect(() => prepareInputBundle(workspace, ["src/model.py", "src/model.py"], policy))
      .toThrowError(expect.objectContaining({ code: "INPUT_INVALID" }));
    expect(() => prepareInputBundle(workspace, ["src/missing.py"], policy))
      .toThrowError(expect.objectContaining({ code: "INPUT_NOT_FOUND" }));
  });

  it("rejects symlinks, hard links, and non-regular files", () => {
    writeFileSync(join(workspace, "src", "target.py"), "model");
    symlinkSync("target.py", join(workspace, "src", "link.py"));
    expect(() => prepareInputBundle(workspace, ["src/link.py"], policy))
      .toThrowError(expect.objectContaining({ code: "LOCAL_PATH_NOT_ALLOWED" }));

    linkSync(join(workspace, "src", "target.py"), join(workspace, "src", "hard.py"));
    expect(() => prepareInputBundle(workspace, ["src/hard.py"], policy))
      .toThrowError(expect.objectContaining({ code: "LOCAL_PATH_NOT_ALLOWED" }));
    expect(() => prepareInputBundle(workspace, ["src"], policy))
      .toThrowError(expect.objectContaining({ code: "INPUT_INVALID" }));
  });

  it("enforces file, count, and total-byte limits", () => {
    writeFileSync(join(workspace, "src", "large.bin"), "123456789");
    expect(() => prepareInputBundle(workspace, ["src/large.bin"], policy))
      .toThrowError(expect.objectContaining({ code: "INPUT_TOO_LARGE" }));

    expect(() => prepareInputBundle(workspace, ["a", "b", "c", "d"], policy))
      .toThrowError(expect.objectContaining({ code: "INPUT_BUNDLE_TOO_LARGE" }));

    writeFileSync(join(workspace, "src", "a.bin"), "1234567");
    writeFileSync(join(workspace, "src", "b.bin"), "1234567");
    expect(() => prepareInputBundle(workspace, ["src/a.bin", "src/b.bin"], policy))
      .toThrowError(expect.objectContaining({ code: "INPUT_BUNDLE_TOO_LARGE" }));
  });

  it("keeps inputs disabled when policy limits are omitted", () => {
    writeFileSync(join(workspace, "src", "model.py"), "model");
    expect(() => prepareInputBundle(workspace, ["src/model.py"], { ...policy, maxInputFiles: 0 }))
      .toThrowError(expect.objectContaining({ code: "INPUT_BUNDLE_TOO_LARGE" }));
  });
});
