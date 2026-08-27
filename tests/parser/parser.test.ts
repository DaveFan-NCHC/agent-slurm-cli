import { describe, expect, it } from "vitest";
import { parseAccountingJob, parseQueueList, parseSubmittedJobId } from "../../src/slurm/parser.js";

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
});
