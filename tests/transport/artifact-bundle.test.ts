import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderArtifactBundleCommand } from "../../src/transport/ssh.js";

describe("artifact bundle command", () => {
  it("archives only safe regular-file paths and quotes the controlled directory", () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-bundle-'"));
    try {
      const source = join(root, "source");
      const archive = join(root, "bundle.tar.gz");
      mkdirSync(join(source, "nested"), { recursive: true });
      writeFileSync(join(source, "result.txt"), "ok\n");
      writeFileSync(join(source, "nested", "model.bin"), "model");
      writeFileSync(join(source, "bad name.txt"), "skip");
      symlinkSync("/etc/passwd", join(source, "outside-link"));

      const bundle = spawnSync("/bin/bash", ["-c", renderArtifactBundleCommand(source, archive, 1024 * 1024)], {
        maxBuffer: 1024 * 1024,
      });
      expect(bundle.status, bundle.stderr.toString()).toBe(0);
      const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
      expect(listing.status, listing.stderr).toBe(0);
      expect(listing.stdout.trim().split("\n").sort()).toEqual(["nested/model.bin", "result.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caps the remote archive before it can exceed the transfer policy", () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-bundle-limit-"));
    try {
      const source = join(root, "source");
      const archive = join(root, "bundle.tar.gz");
      mkdirSync(source);
      writeFileSync(join(source, "result.bin"), "x".repeat(4096));
      const bundle = spawnSync("/bin/bash", ["-c", renderArtifactBundleCommand(source, archive, 10)]);
      expect(bundle.status).toBe(73);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves a safe requested prefix inside the archive", () => {
    const root = mkdtempSync(join(tmpdir(), "slurm-agent-bundle-prefix-"));
    try {
      const source = join(root, "source");
      const archive = join(root, "bundle.tar.gz");
      mkdirSync(join(source, "airfoil_unsteady", "VTK"), { recursive: true });
      writeFileSync(join(source, "airfoil_unsteady", "VTK", "frame.vtu"), "mesh");
      writeFileSync(join(source, "other.bin"), "skip");
      const bundle = spawnSync(
        "/bin/bash",
        ["-c", renderArtifactBundleCommand(source, archive, 1024 * 1024, "airfoil_unsteady/VTK")],
        { maxBuffer: 1024 * 1024 },
      );
      expect(bundle.status, bundle.stderr.toString()).toBe(0);
      const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
      expect(listing.status, listing.stderr).toBe(0);
      expect(listing.stdout.trim()).toBe("airfoil_unsteady/VTK/frame.vtu");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe bundle prefixes before rendering a shell command", () => {
    expect(() => renderArtifactBundleCommand("/work", "/tmp/a.tar.gz", 1024, "../escape")).toThrow();
  });
});
