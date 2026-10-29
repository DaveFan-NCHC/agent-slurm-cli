import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { QueryExecutor, Sink } from "../support/cli.js";

describe("CLI argument and discovery boundary", () => {
  it.each(["exec", "ssh", "shell", "run", "command"])("does not expose %s", async (command) => {
    const stdout = new Sink();
    const stderr = new Sink();
    const code = await main([command, "id"], {}, stdout, stderr as never);
    expect(code).toBe(2);
    expect(JSON.parse(stdout.value)).toMatchObject({
      ok: false, error: { category: "INVALID_ARGUMENT", code: "INVALID_ARGUMENT" },
    });
  });
  it("prints help without loading credentials", async () => {
    const stdout = new Sink();
    expect(await main(["--help"], {}, stdout)).toBe(0);
    expect(stdout.value).toContain("slurm-agent submit");
    expect(stdout.value).toContain("slurm-agent session open|status|close");
    expect(stdout.value).toContain("slurm-agent policy");
    expect(stdout.value).toContain("slurm-agent modules");
    expect(stdout.value).toContain("slurm-agent discover cluster|modules|associations|runtimes");
    expect(stdout.value).toContain("slurm-agent artifact JOB_ID --path RELATIVE_PATH [--force]");
    expect(stdout.value).toContain("slurm-agent artifacts JOB_ID [--download [--prefix RELATIVE_DIRECTORY] [--force]]");
    expect(stdout.value).toContain("--artifact-input REF");
    expect(stdout.value).not.toContain("slurm-agent artifact-bundle");
  });
  it("rejects an unknown session action before loading credentials", async () => {
    const stdout = new Sink();
    expect(await main(["session", "restart"], {}, stdout)).toBe(2);
    expect(JSON.parse(stdout.value)).toMatchObject({
      ok: false, error: { code: "INVALID_ARGUMENT" },
    });
  });
  it.each([
    ["submit", "--script", "jobs/a.sh", "--partition", "p", "--export", "ALL"],
    ["cancel", "1", "--user", "all"],
    ["list", "--sort", "%i"],
    ["logs", "1", "--path", "/etc/passwd"],
    ["artifact", "1", "--output", "/etc/passwd"],
    ["artifact", "1"],
    ["artifact", "1", "--path", "../../etc/passwd", "--overwrite", "true"],
    ["artifacts", "1", "--download=false"],
    ["artifacts", "1", "--prefix", "VTK"],
    ["artifacts", "1", "--download", "--prefix="],
    ["artifacts", "1", "--force"],
    ["artifact", "1", "--path", "model.bin", "--force=false"],
    ["cluster-info", "--partition", "gpu"],
    ["policy", "--set", "max_nodes=99"],
    ["nodes", "--state", "NOT_A_NODE_STATE"],
    ["wait", "1", "--poll-interval", "0"],
    ["history", "--days", "0"],
    ["history", "--state", "NOT_A_STATE"],
    ["usage", "1", "--user", "all"],
    ["update", "1"],
    ["signal", "1", "--signal", "TERM", "--scope", "children"],
    ["submit", "--partition", "p", "--exclusive=false", "jobs/a.sh"],
    ["list", "--input", "data.bin"],
    ["discover", "unknown"],
    ["discover", "cluster", "extra"],
  ])("rejects unexpected command options before loading credentials", async (...argv) => {
    const stdout = new Sink();
    const code = await main(argv, {}, stdout);
    expect(code).toBe(2);
    expect(JSON.parse(stdout.value)).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
  });

  it("runs discovery without loading operational policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-slurm-cli-discover-"));
    try {
      writeFileSync(join(root, "key"), "test-key");
      writeFileSync(join(root, "known_hosts"), "host ssh-ed25519 AAAA\n");
      const remote = new QueryExecutor([
        { stdout: "gpu*|up|01:00:00|1|idle|0/8/0/8|gpu:h200:1\n", stderr: "", exitCode: 0 },
        {
          stdout: "gpu01|gpu*|idle|8|64000|gpu:h200:1|h200\n",
          stderr: "", exitCode: 0,
        },
      ]);
      const stdout = new Sink();
      expect(await main(
        ["discover", "cluster"],
        {
          SLURM_SSH_HOST: "host", SLURM_SSH_USER: "alice", SLURM_SSH_KEY_PATH: join(root, "key"),
          SLURM_SSH_KNOWN_HOSTS: join(root, "known_hosts"), SLURM_REMOTE_WORKSPACE: "/work",
          SLURM_POLICY_PATH: join(root, "missing-policy.yaml"),
        },
        stdout,
        new Sink() as never,
        () => remote,
      )).toBe(0);
      expect(JSON.parse(stdout.value)).toMatchObject({
        ok: true,
        discovery: "cluster",
        partitions: [{ partition: "gpu" }],
        nodes: [{ node_name: "gpu01", partition: "gpu" }],
      });
      expect(remote.commands).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


});

