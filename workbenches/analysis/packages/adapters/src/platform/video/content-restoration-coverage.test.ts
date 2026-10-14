import { describe, expect, it } from "vitest";
import { contentRestorationCoverageDiagnostics } from "./video-builder-integrity.js";
const lens = (ranges: number[][]) => ({ blocks: ranges.map(([start, end]) => ({ timeRange: { start, end } })) });
describe("continuous content restoration coverage", () => {
  it("rejects the real gripper failure even when a summary describes the missing ending", () => {
    const value = { ...lens([[0, 4.6], [6, 12.56], [14.733, 23], [23, 32.4], [32.4, 41.48]]),
      summary: "The ant, drone and ending are mentioned here." };
    const errors = contentRestorationCoverageDiagnostics(value, 60.8);
    expect(errors).toHaveLength(3);
    expect(errors.at(-1)).toContain("uncovered=41.48..60.8s");
    expect(errors.at(-1)).toContain("summary text does not replace blocks");
  });
  it("accepts full coverage, overlapping references and the existing half-second timing tolerance", () => {
    expect(contentRestorationCoverageDiagnostics(lens([[0, 10], [9, 25], [25, 43.78]]), 43.909)).toEqual([]);
    expect(contentRestorationCoverageDiagnostics(lens([[0.5, 10], [10.5, 20]]), 20.5)).toEqual([]);
  });
  it("does not let a summary or malformed range hide missing prose", () => {
    expect(contentRestorationCoverageDiagnostics({ summary: "Complete", blocks: [] }, 10)[0]).toContain("uncovered=0..10s");
    expect(contentRestorationCoverageDiagnostics(lens([[0, 5], [5, 99]]), 10)[0]).toContain("uncovered=5..10s");
  });
  it("returns exact interior intervals for bounded local correction", () => {
    expect(contentRestorationCoverageDiagnostics(lens([[0, 4], [6, 10]]), 10)[0]).toContain("uncovered=4..6s");
  });
});
