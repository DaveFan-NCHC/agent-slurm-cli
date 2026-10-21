import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenSshCluster } from "./support/openssh-cluster.js";

describe("OpenSSH integration security failures", () => {
  let cluster: OpenSshCluster;

  beforeAll(async () => { cluster = await OpenSshCluster.start(); });
  beforeEach(() => cluster.setMode("normal"));
  afterAll(() => cluster.stop());

  it("rejects a mismatched SSH host fingerprint", () => {
    const result = cluster.run(["cluster-info"], {
      SLURM_SSH_HOST_FINGERPRINT: `SHA256:${"A".repeat(43)}`,
    });
    expect(result.status).toBe(4);
    expect(result.json).toMatchObject({
      ok: false,
      error: { category: "TRANSPORT_FAILURE", code: "SSH_HOST_VERIFICATION_FAILED" },
    });
  });

  it("rejects an unauthorized client key", () => {
    const result = cluster.run(["cluster-info"], {
      SLURM_SSH_KEY_PATH: cluster.unauthorizedKey,
    });
    expect(result.status).toBe(4);
    expect(result.json).toMatchObject({
      ok: false,
      error: { category: "TRANSPORT_FAILURE", code: "SSH_AUTH_FAILED" },
    });
  });

  it("fails closed when Slurm returns another user's job", () => {
    cluster.setMode("foreign");
    const result = cluster.run(["status", "12345"]);
    expect(result.status).toBe(7);
    expect(result.json).toMatchObject({
      ok: false,
      error: { category: "PERMISSION_DENIED", code: "JOB_NOT_OWNED_BY_USER" },
    });
  });

  it("fails closed on malformed successful Slurm output", () => {
    cluster.setMode("malformed");
    const result = cluster.run(["status", "12345"]);
    expect(result.status).toBe(5);
    expect(result.json).toMatchObject({
      ok: false,
      error: { category: "SLURM_FAILURE", code: "SLURM_QUERY_FAILED" },
    });
  });
});
