import { describe, expect, it } from "vitest";
import { parseAccountingJob, parseClusterInfo, parseQueueList, parseSubmittedJobId } from "../../src/slurm/parser.js";

describe("Slurm parsers", () => {
  it("parses queue rows", () => {
    expect(parseQueueList("123|test|slurm-test|RUNNING|00:03:21\n")).toEqual([
      { job_id: "123", name: "test", partition: "slurm-test", state: "RUNNING", elapsed: "00:03:21" },
    ]);
  });
  it("selects the allocation and ignores steps", () => {
    const output = "123|alice|test|p|COMPLETED|00:10:00|0:0\n123.batch|alice|batch|p|COMPLETED|00:10:00|0:0\n";
    expect(parseAccountingJob(output, "123")?.exit_code).toBe("0:0");
  });
  it("accepts parsable federation output", () => expect(parseSubmittedJobId("12345;cluster\n")).toBe("12345"));
  it("rejects malformed submission output", () => expect(() => parseSubmittedJobId("123; rm -rf")).toThrow());
  it("parses partition and resource summaries", () => {
    expect(parseClusterInfo("gpu*|up|1-00:00:00|2|mix|8/24/0/32|gpu:a100:4,nvme:1\n")).toEqual([{
      partition: "gpu", availability: "up", time_limit: "1-00:00:00", nodes: 2,
      node_state: "mix", cpus: { allocated: 8, idle: 24, other: 0, total: 32 },
      gres: ["gpu:a100:4", "nvme:1"],
    }]);
  });
});
