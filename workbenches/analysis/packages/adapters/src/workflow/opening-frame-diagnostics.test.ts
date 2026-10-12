import { describe, expect, it } from "vitest";
import { collectOpeningFrameDiagnostics } from "./opening-frame-diagnostics.js";

function reconstruction(segments: unknown[], duration = 4) {
  return { builderLenses: { visualEditing: { openingAnalysis: { duration, segments } } } };
}

function segment(id: string, start: number, end: number, frameRefs: unknown) {
  return { id, timeRange: { start, end }, frameRefs };
}

describe("collectOpeningFrameDiagnostics", () => {
  it("collects independent frame and range errors across every segment in one call", () => {
    const input = reconstruction([
      segment("intro", 0.2, 1.5, ["outside-start", "missing-a", "late-a"]),
      segment("middle", 1.6, 3.1, ["middle-a", "middle-b"]),
      segment("middle", 3.1, 4.2, ["late-c"])
    ]);
    const frames = new Map([
      ["outside-start", -1], ["late-a", 1.4], ["middle-a", 1.6], ["middle-b", 3], ["late-c", 4.2],
      ["OPEN-good", 0], ["actual", 0.5], ["actual-end", 4]
    ]);
    const before = structuredClone(input);
    const issues = collectOpeningFrameDiagnostics(input, 4, frames);

    expect(issues.some((issue) => issue.includes("segments[0].timeRange.start") && issue.includes("range=[0.2,1.5]"))).toBe(true);
    expect(issues.some((issue) => issue.includes("segments[0].frameRefs[0]") && issue.includes("outside-start") && issue.includes("time=-1"))).toBe(true);
    expect(issues.some((issue) => issue.includes("segments[0].frameRefs[1]") && issue.includes("missing-a") && issue.includes("time=missing"))).toBe(true);
    expect(issues.some((issue) => issue.includes("segments[1].timeRange.start") && issue.includes("range=[1.6,3.1]"))).toBe(true);
    expect(issues.some((issue) => issue.includes("segments[2].id") && issue.includes('duplicate="middle"'))).toBe(true);
    expect(issues.some((issue) => issue.includes("segments[2].timeRange") && issue.includes("outside opening"))).toBe(true);
    expect(issues.some((issue) => issue.includes("segments[2].frameRefs") && issue.includes("range=[3.1,4.2]"))).toBe(true);
    expect(input).toEqual(before);
  });

  it("does not let known frames outside a segment count toward its frame strip", () => {
    const input = reconstruction([segment("only", 0, 2, ["too-early", "known-a", "known-b", "too-late"])]);
    const frames = new Map([["too-early", -0.2], ["known-a", 0.8], ["known-b", 1.5], ["too-late", 2.2]]);
    const issues = collectOpeningFrameDiagnostics(input, 4, frames);

    expect(issues.some((issue) => issue.includes("frameRefs[0]") && issue.includes("time=-0.2"))).toBe(true);
    expect(issues.some((issue) => issue.includes("frameRefs[3]") && issue.includes("time=2.2"))).toBe(true);
    expect(issues.some((issue) => issue.includes("start gap=0.8"))).toBe(true);
    expect(issues.some((issue) => issue.includes("available=known-a@0.8,known-b@1.5"))).toBe(true);
    const gapIssue = issues.find((issue) => issue.includes("start gap=0.8")) ?? "";
    expect(gapIssue).not.toContain("too-early@-0.2");
    expect(gapIssue).not.toContain("too-late@2.2");
  });

  it("accepts the canonical 0.05, 0.55, and 1.01 boundaries", () => {
    const input = reconstruction([segment("one", 0, 2.11, ["edge", "start", "middle", "end"])], 2.11);
    const frames = new Map([["edge", -0.05], ["start", 0.55], ["middle", 1.56], ["end", 2.11]]);
    const issues = collectOpeningFrameDiagnostics(input, 2.11, frames);
    expect(issues).toEqual([]);
  });

  it("reports malformed or empty openings safely and lists only known frame IDs", () => {
    const issues = collectOpeningFrameDiagnostics({ builderLenses: { visualEditing: { openingAnalysis: { duration: 4, segments: [] } } } }, 4,
      new Map([["OPEN-real", 0], ["duplicate-at-open", 0], ["real", 2], ["outside-opening", 5]]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("segments: missing, malformed, or empty");
    expect(issues[0]).toContain("OPEN-real@0,real@2");
    expect(issues[0]).not.toContain("duplicate-at-open");
    expect(issues[0]).not.toContain("outside-opening");
    expect(collectOpeningFrameDiagnostics(null, 4, new Map()).join(" ")).toContain("missing or malformed opening analysis");
  });

  it("reports each excessive start, interior, and end gap", () => {
    const input = reconstruction([segment("wide-gaps", 0, 4, ["a", "b", "c"])]);
    const issues = collectOpeningFrameDiagnostics(input, 4, new Map([["a", 0.6], ["b", 2], ["c", 3.2]]));
    expect(issues.some((issue) => issue.includes("start gap=0.6"))).toBe(true);
    expect(issues.some((issue) => issue.includes("interior gap=1.4 at 0.6..2"))).toBe(true);
    expect(issues.some((issue) => issue.includes("end gap=0.7999999999999998"))).toBe(true);
  });
});
