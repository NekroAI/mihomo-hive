import { afterEach, describe, expect, it } from "vitest";
import { appendJobLog, finalizeJobLog, getJobLog, __resetJobLogBuffers } from "./job-log-buffer.js";

describe("job-log-buffer (P5-AT)", () => {
  afterEach(() => __resetJobLogBuffers());

  it("append + get returns lines in order", () => {
    appendJobLog("j1", "a", "2026-05-29T12:00:00.000Z");
    appendJobLog("j1", "b", "2026-05-29T12:00:01.000Z");
    const lines = getJobLog("j1");
    expect(lines.map((l) => l.text)).toEqual(["a", "b"]);
    expect(lines[0]?.ts).toBe("2026-05-29T12:00:00.000Z");
  });

  it("finalize returns tail string and clears buffer", () => {
    appendJobLog("j2", "x", "2026-05-29T12:00:00.000Z");
    appendJobLog("j2", "y", "2026-05-29T12:00:05.000Z");
    const tail = finalizeJobLog("j2");
    expect(tail).toContain("12:00:00 x");
    expect(tail).toContain("12:00:05 y");
    expect(getJobLog("j2")).toEqual([]); // 已清空
  });

  it("ring buffer caps at MAX_LINES", () => {
    for (let i = 0; i < 350; i++) appendJobLog("j3", `line-${i}`);
    const lines = getJobLog("j3");
    expect(lines.length).toBeLessThanOrEqual(300);
    // 最旧的被裁掉，保留最新
    expect(lines[lines.length - 1]?.text).toBe("line-349");
  });

  it("truncates overlong lines", () => {
    appendJobLog("j4", "z".repeat(1000));
    expect(getJobLog("j4")[0]?.text.length).toBe(500);
  });
});
