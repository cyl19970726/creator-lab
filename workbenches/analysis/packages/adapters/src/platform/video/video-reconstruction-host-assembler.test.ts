import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assembleHostOwnedReconstruction, frozenReconstructionTranscriptFromEvidencePack } from "./video-reconstruction-host-assembler.js";

const fixtures = path.join(process.cwd(), ".agents", "skills", "video-content-reconstruction", "tests", "fixtures", "valid");

function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-video-assembly-"));
  fs.mkdirSync(path.join(root, "evidence"), { recursive: true });
  fs.copyFileSync(path.join(fixtures, "evidence-pack.json"), path.join(root, "evidence/evidence-pack.json"));
  fs.copyFileSync(path.join(fixtures, "probe.json"), path.join(root, "probe.json"));
  fs.copyFileSync(path.join(fixtures, "reconstruction.json"), path.join(root, "reconstruction.json"));
  return root;
}

describe("Host-owned video reconstruction assembly", () => {
  it("projects only complete frozen cue fields and rejects a malformed frozen source", () => {
    const pack = JSON.parse(fs.readFileSync(path.join(fixtures, "evidence-pack.json"), "utf8")) as Record<string, unknown>;
    const projected = frozenReconstructionTranscriptFromEvidencePack(pack);
    expect(projected).toEqual({ origin: "fixture", cues: [
      { id: "CUE-001", start: 0, end: 5, text: "先打开设置", representativeFrame: "frames/cues/cue-001.jpg", overlappingShots: ["SHOT-001"] },
      { id: "CUE-002", start: 5, end: 10, text: "然后得到结果", representativeFrame: "frames/cues/cue-002.jpg", overlappingShots: ["SHOT-002"] }
    ] });
    expect(() => frozenReconstructionTranscriptFromEvidencePack({ transcript: { cues: [{ id: "CUE-1" }] } }))
      .toThrow("HOST_ASSEMBLY_FROZEN_TRANSCRIPT_CUE_INVALID:0");
    expect(() => frozenReconstructionTranscriptFromEvidencePack({ transcript: {} }))
      .toThrow("HOST_ASSEMBLY_FROZEN_TRANSCRIPT_MISSING");
  });

  it("restores frozen cue fields and normalizes mechanical carrier state without changing semantic units", () => {
    const root = createFixture();
    try {
      const reconstructionPath = path.join(root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      const originalUnits = structuredClone(reconstruction.knowledgeUnits);
      const originalAccountability = structuredClone(reconstruction.coverageMatrix.cueAccountability);
      reconstruction.transcript.origin = "model-supplied placeholder";
      reconstruction.transcript.cues[0].representativeFrame = "invented-frame-id";
      reconstruction.coverageMatrix.channels[0] = {
        ...reconstruction.coverageMatrix.channels[0], available: false, inspected: false,
        inspectionStatus: "checked_readable"
      };
      reconstruction.metaGate.question = "Localized display question";
      delete reconstruction.metaGate.questionId;
      fs.writeFileSync(reconstructionPath, JSON.stringify(reconstruction));

      const report = assembleHostOwnedReconstruction(root);
      const assembled = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      expect(report.transcriptCuesRestored).toBe(2);
      expect(assembled.transcript.origin).toBe("fixture");
      expect(assembled.transcript.cues[0].representativeFrame).toBe("frames/cues/cue-001.jpg");
      expect(assembled.coverageMatrix.channels[0]).toMatchObject({ available: true, inspected: true, inspectionStatus: "checked_readable" });
      expect(assembled.metaGate).toMatchObject({ questionId: "uncovered_information_audit", question: "Localized display question" });
      expect(assembled.knowledgeUnits).toEqual(originalUnits);
      expect(assembled.coverageMatrix.cueAccountability).toEqual(originalAccountability);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the explicit frozen-pack fallback when transcript origin is absent", () => {
    const root = createFixture();
    try {
      const packPath = path.join(root, "evidence/evidence-pack.json");
      const reconstructionPath = path.join(root, "reconstruction.json");
      const pack = JSON.parse(fs.readFileSync(packPath, "utf8"));
      const reconstruction = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      delete pack.transcript.origin;
      reconstruction.transcript.origin = "invented by model";
      fs.writeFileSync(packPath, JSON.stringify(pack));
      fs.writeFileSync(reconstructionPath, JSON.stringify(reconstruction));
      assembleHostOwnedReconstruction(root);
      const assembled = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      expect(assembled.transcript.origin).toBe("frozen_evidence_pack");
      expect(assembled.transcript.cues).toHaveLength(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps invalid sweep provenance as a warning rather than deleting the candidate", () => {
    const root = createFixture();
    try {
      const probePath = path.join(root, "probe.json");
      const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
      probe.informationCarriers[0].discoveredIn = ["media-preparation.json"];
      fs.writeFileSync(probePath, JSON.stringify(probe));
      expect(assembleHostOwnedReconstruction(root).probeWarnings)
        .toContain("probe_carrier_sweep_trace:CAR-SPEECH");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("synchronizes a matching Builder rationale into the probe without changing semantic units", () => {
    const root = createFixture();
    try {
      const probePath = path.join(root, "probe.json");
      const reconstructionPath = path.join(root, "reconstruction.json");
      const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
      const reconstruction = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      const originalUnits = structuredClone(reconstruction.knowledgeUnits);
      delete probe.informationCarriers[0].inspectionRationale;
      probe.informationCarriers[0].inspectionStatus = "unchecked";
      probe.informationCarriers[0].available = true;
      probe.informationCarriers[0].inspected = false;
      fs.writeFileSync(probePath, JSON.stringify(probe));

      const report = assembleHostOwnedReconstruction(root);
      const assembledProbe = JSON.parse(fs.readFileSync(probePath, "utf8"));
      const assembledReconstruction = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      expect(report.carrierRationalesSynchronized).toBe(1);
      expect(assembledProbe.informationCarriers[0]).toMatchObject({
        inspectionStatus: "checked_readable",
        available: true,
        inspected: true,
        inspectionRationale: "Transcript and cue timing were inspected."
      });
      expect(assembledReconstruction.knowledgeUnits).toEqual(originalUnits);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores one mechanical accountability row for every frozen transcript cue", () => {
    const root = createFixture();
    try {
      const reconstructionPath = path.join(root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      reconstruction.coverageMatrix.cueAccountability = [];
      fs.writeFileSync(reconstructionPath, JSON.stringify(reconstruction));

      const report = assembleHostOwnedReconstruction(root);
      const assembled = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      expect(report.cueAccountabilityRowsRestored).toBe(2);
      expect(assembled.coverageMatrix.cueAccountability).toEqual([
        {
          cueId: "CUE-001", disposition: "knowledge", unitIds: ["KU-001"],
          rationale: "Host 按冻结 Cue 与知识单元时间范围生成机械候选回链。",
          assignmentSource: "host_time_overlap"
        },
        {
          cueId: "CUE-002", disposition: "knowledge", unitIds: ["KU-002"],
          rationale: "Host 按冻结 Cue 与知识单元时间范围生成机械候选回链。",
          assignmentSource: "host_time_overlap"
        }
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("upgrades legacy cue rows without replacing their existing unit mapping", () => {
    const root = createFixture();
    try {
      const reconstructionPath = path.join(root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      reconstruction.coverageMatrix.cueAccountability = [
        { cueId: "CUE-001", unitIds: ["KU-002"] },
        { cueId: "CUE-002", unitIds: [] }
      ];
      fs.writeFileSync(reconstructionPath, JSON.stringify(reconstruction));

      const report = assembleHostOwnedReconstruction(root);
      const assembled = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      expect(report.cueAccountabilityRowsRestored).toBe(2);
      expect(assembled.coverageMatrix.cueAccountability).toMatchObject([
        { cueId: "CUE-001", disposition: "knowledge", unitIds: ["KU-002"] },
        { cueId: "CUE-002", disposition: "knowledge", unitIds: ["KU-002"] }
      ]);
      expect(assembled.coverageMatrix.cueAccountability[0].rationale).toContain("Host");
      expect(assembled.coverageMatrix.cueAccountability[1].rationale).toContain("Host");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("repairs Builder template rows that classify cues but leave every unit link empty", () => {
    const root = createFixture();
    try {
      const reconstructionPath = path.join(root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      reconstruction.coverageMatrix.cueAccountability = reconstruction.coverageMatrix.cueAccountability.map(
        (row: Record<string, unknown>) => ({
          ...row,
          disposition: "context",
          unitIds: [],
          rationale: "其信息已在相邻知识单元中归纳。"
        })
      );
      fs.writeFileSync(reconstructionPath, JSON.stringify(reconstruction));

      const report = assembleHostOwnedReconstruction(root);
      const assembled = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      expect(report.cueAccountabilityRowsRepaired).toBe(2);
      expect(report.cueAccountabilityRowsRestored).toBe(0);
      expect(report.cueAccountabilityRowsHostOwned).toBe(2);
      expect(assembled.coverageMatrix.cueAccountability).toMatchObject([
        { cueId: "CUE-001", disposition: "context", unitIds: ["KU-001"], assignmentSource: "host_time_overlap" },
        { cueId: "CUE-002", disposition: "context", unitIds: ["KU-002"] }
      ]);
      expect(assembled.coverageMatrix.cueAccountability[0].rationale).toContain("补全 Builder 的空回链");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recomputes Host-owned mappings after a Builder repair changes unit ranges", () => {
    const root = createFixture();
    try {
      const reconstructionPath = path.join(root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      reconstruction.coverageMatrix.cueAccountability = [];
      fs.writeFileSync(reconstructionPath, JSON.stringify(reconstruction));
      assembleHostOwnedReconstruction(root);

      const first = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      expect(first.coverageMatrix.cueAccountability[0].unitIds).toEqual(["KU-001"]);
      first.knowledgeUnits[0].timeRange = { start: 20, end: 25 };
      fs.writeFileSync(reconstructionPath, JSON.stringify(first));

      const report = assembleHostOwnedReconstruction(root);
      const second = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      expect(second.coverageMatrix.cueAccountability[0].unitIds).toEqual(["KU-002"]);
      expect(report.cueAccountabilityRowsHostOwned).toBe(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes an unregistered absolute source path while preserving valid evidence", () => {
    const root = createFixture();
    try {
      const reconstructionPath = path.join(root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      reconstruction.knowledgeUnits[0].evidence.push({
        refType: "source",
        ref: "/private/runtime/source-video.mp4",
        supports: "Legacy runtime path must not become a durable evidence ID."
      });
      fs.writeFileSync(reconstructionPath, JSON.stringify(reconstruction));

      const report = assembleHostOwnedReconstruction(root);
      const assembled = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      expect(report.invalidAbsoluteSourceRefsRemoved).toBe(1);
      expect(assembled.knowledgeUnits[0].evidence).not.toContainEqual(
        expect.objectContaining({ ref: "/private/runtime/source-video.mp4" })
      );
      expect(assembled.knowledgeUnits[0].evidence.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
