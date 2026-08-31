import { describe, expect, it } from "vitest";
import {
  parseAccountingJob, parseClusterInfo, parseHistory, parseJobUsage, parseLiveUsage,
  parseQueueList, parseSubmittedJobId,
} from "../../src/slurm/parser.js";

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
  it("parses accounting history rows", () => {
    const output = [
      "44", "alice", "train", "gpu", "COMPLETED", "00:10:00",
      "2026-08-30T10:00:00", "2026-08-30T10:10:00", "0:0", "4", "1", "2Gn",
      "billing=4,cpu=4,mem=2G,node=1",
    ].join("|");
    expect(parseHistory(`${output}\n`)).toEqual([{
      job_id: "44", user: "alice", name: "train", partition: "gpu", state: "COMPLETED",
      elapsed: "00:10:00", start: "2026-08-30T10:00:00", end: "2026-08-30T10:10:00",
      exit_code: "0:0", allocated_cpus: 4, allocated_nodes: 1, requested_memory: "2Gn",
      requested_tres: "billing=4,cpu=4,mem=2G,node=1",
    }]);
  });
  it("calculates CPU and memory efficiency from accounting steps", () => {
    const allocation = [
      "44", "alice", "train", "gpu", "COMPLETED", "00:10:00", "600", "4", "1", "2Gn",
      "billing=4,cpu=4,mem=2G,node=1", "billing=4,cpu=4,mem=2G,node=1",
      "00:20:00", "", "", "", "", "0:0",
    ].join("|");
    const batch = [
      "44.batch", "alice", "batch", "gpu", "COMPLETED", "00:10:00", "600", "4", "1", "", "",
      "cpu=4,mem=2G", "00:20:00", "1G", "2G", "100M", "50M", "0:0",
    ].join("|");
    expect(parseJobUsage(`${allocation}\n${batch}\n`, "44")?.usage).toMatchObject({
      job_id: "44", cpu_efficiency_percent: 50, memory_efficiency_percent: 50,
      max_rss: "1G", max_vm_size: "2G", max_disk_read: "100M", max_disk_write: "50M",
      steps: [{ step_id: "44.batch", total_cpu: "00:20:00", max_rss: "1G" }],
    });
  });
  it("parses live sstat step metrics", () => {
    expect(parseLiveUsage("44.batch|00:05:00|512M|1G|10M|5M|cpu=4,mem=2G\n")).toEqual([{
      step_id: "44.batch", average_cpu: "00:05:00", max_rss: "512M", max_vm_size: "1G",
      max_disk_read: "10M", max_disk_write: "5M", allocated_tres: "cpu=4,mem=2G",
    }]);
  });
});
