import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "../support/session.js";
import { OpenSshCluster } from "./support/openssh-cluster.js";

describe("persistent CLI session over OpenSSH", () => {
  let cluster: OpenSshCluster;

  beforeAll(async () => { cluster = await OpenSshCluster.start(); });
  afterAll(() => cluster.stop());

  it("opens, reuses, serves commands, and closes a detached worker", async () => {
    const opened = cluster.run(["session", "open"]);
    expect(opened.status, opened.stderr).toBe(0);
    expect(opened.json).toMatchObject({ ok: true, session: { state: "ready", reused: false } });
    const metadataPath = cluster.sessionMetadataPath();
    expect(metadataPath).toBeDefined();
    const metadata = JSON.parse(readFileSync(metadataPath!, "utf8")) as { pid: number };
    expect(metadata.pid).not.toBe(process.pid);

    const reused = cluster.run(["session", "open"]);
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.json).toMatchObject({ ok: true, session: { state: "ready", reused: true } });

    const status = cluster.run(["session", "status"]);
    expect(status.status, status.stderr).toBe(0);
    expect(status.json).toMatchObject({ ok: true, session: { state: "ready", command_connection: "ready" } });

    const listed = cluster.run(["list"]);
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.json).toMatchObject({ ok: true, jobs: [{ job_id: "12345", state: "RUNNING" }] });

    const closed = cluster.run(["session", "close"]);
    expect(closed.status, closed.stderr).toBe(0);
    expect(closed.json).toMatchObject({ ok: true, session: { closed: true, state: "closed" } });
    await waitFor(() => !existsSync(metadataPath!), 3000);
  });
});
