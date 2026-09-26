import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { steps } from "./workflow.mjs";
const coreSteps = new Set(steps.map((step) => step.id));
const digest = (s) =>
  crypto.createHash("sha256").update(s).digest("hex").slice(0, 24);
export function projectCatalog(c, root, mediaRoot) {
  const source = path.join(root, "data/workbench/topics.json");
  if (!fs.existsSync(source))
    throw Error("选题版本清单缺失，无法确认当前产物关系");
  const manifest = JSON.parse(fs.readFileSync(source, "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.topics)
  )
    throw Error("选题清单格式不正确");
  const ids = new Set(),
    merged = [],
    used = new Set();
  for (const def of manifest.topics) {
    if (!def.id || ids.has(def.id) || !Array.isArray(def.revisions))
      throw Error("选题清单存在重复或缺失身份");
    ids.add(def.id);
    const sources = c.topics.filter((t) => def.sourceTopics.includes(t.id));
    sources.forEach((t) => used.add(t.id));
    const revisions = def.revisions.map((v) => ({
      ...v,
      coreIds: {},
      missingCores: [],
      artifactIds: [],
      inputCoreIds: {},
    }));
    if (
      new Set(revisions.map((r) => r.id)).size !== revisions.length ||
      ![def.currentReport, def.currentVideo].every((id) =>
        revisions.some((r) => r.id === id),
      )
    )
      throw Error("当前版本引用无效");
    const artifacts = [
      ...new Map(
        sources.flatMap((t) => t.artifacts).map((a) => [a.path, { ...a }]),
      ).values(),
    ];
    const reviews = sources.flatMap((t) => t.reviews);
    for (const a of artifacts) {
      const sourceTopic = sources.find((t) =>
        t.artifacts.some((f) => f.path === a.path),
      );
      a.logicalUri = a.path.startsWith(mediaRoot + path.sep)
        ? "media://" + path.relative(mediaRoot, a.path)
        : a.path.startsWith(root + path.sep)
          ? path.relative(root, a.path)
          : a.path;
      const explicit = revisions.filter(
        (v) =>
          Object.values(v.cores || {}).includes(a.logicalUri) ||
          (v.artifactUris || []).includes(a.logicalUri),
      );
      if (explicit.length > 1) throw Error("产物重复归属：" + a.logicalUri);
      const rev =
        explicit[0] ||
        revisions.find(
          (v) => v.sourceTopic === sourceTopic.id && v.areas?.includes(a.area),
        );
      a.revisionId = rev?.id || "feedback";
      a.topicId = def.id;
      a.legacyIds = [a.id];
      a.id = digest(def.id + ":" + a.revisionId + ":" + a.logicalUri);
      if (rev) {
        rev.artifactIds.push(a.id);
        for (const [step, uri] of Object.entries(rev.cores || {})) {
          if (a.logicalUri === uri) {
            a.id = digest(def.id + ":" + rev.id + ":core:" + step);
            rev.artifactIds[rev.artifactIds.length - 1] = a.id;
            rev.coreIds[step] = a.id;
            a.coreStep = step;
          }
        }
      }
    }
    // Resolve inputs only after original assets have their final IDs and owners.
    // A reference never transfers ownership or creates another artifact.
    for (const rev of revisions) {
      if (rev.inputRefs !== undefined && !Array.isArray(rev.inputRefs))
        throw Error("输入引用格式不正确：" + rev.id);
      const seen = new Set();
      rev.inputRefs = (rev.inputRefs || []).map((ref) => {
        if (
          !ref ||
          typeof ref !== "object" ||
          Array.isArray(ref) ||
          !/^[a-f0-9]{24}$/.test(ref.assetId || "") ||
          typeof ref.sourceRevisionId !== "string" ||
          !ref.sourceRevisionId ||
          (ref.label !== undefined &&
            (typeof ref.label !== "string" || ref.label.length > 200))
        )
          throw Error("输入引用格式不正确：" + rev.id);
        const asset = artifacts.find((a) => a.id === ref.assetId);
        if (!asset) throw Error("输入资产未登记于本选题：" + ref.assetId);
        if (
          asset.revisionId !== ref.sourceRevisionId ||
          !revisions.some((r) => r.id === ref.sourceRevisionId)
        )
          throw Error("输入资产来源版本不符：" + ref.assetId);
        if (asset.revisionId === rev.id)
          throw Error("本版产出不能声明为沿用输入：" + ref.assetId);
        const key = ref.assetId + ":" + (ref.step || "");
        if (seen.has(key)) throw Error("重复输入引用：" + ref.assetId);
        seen.add(key);
        if (ref.step !== undefined) {
          if (!coreSteps.has(ref.step))
            throw Error("输入引用步骤无效：" + ref.step);
          if (
            Object.hasOwn(rev.cores || {}, ref.step) ||
            Object.hasOwn(rev.inputCoreIds, ref.step)
          )
            throw Error("输入引用步骤入口重复：" + ref.step);
          rev.inputCoreIds[ref.step] = asset.id;
        }
        return {
          assetId: asset.id,
          sourceRevisionId: asset.revisionId,
          ...(ref.step !== undefined ? { step: ref.step } : {}),
          ...(ref.label !== undefined ? { label: ref.label } : {}),
          uri: asset.logicalUri,
          name: asset.name,
        };
      });
    }
    for (const rev of revisions) {
      for (const [step, uri] of Object.entries(rev.cores || {}))
        if (!rev.coreIds[step]) rev.missingCores.push({ step, uri });
      rev.previewIds = Object.fromEntries(
        Object.entries(rev.previews || {}).map(([step, uris]) => [
          step,
          uris
            .map((uri) => artifacts.find((a) => a.logicalUri === uri)?.id)
            .filter(Boolean),
        ]),
      );
      if (rev.decision) {
        const evidence = artifacts.find(
          (a) => a.logicalUri === rev.decision.source,
        );
        rev.decision = {
          ...rev.decision,
          sourceId: evidence?.id || null,
          verifiedSource: !!evidence,
        };
      }
    }
    for (const rv of reviews) {
      const f = artifacts.find((a) => a.legacyIds.includes(rv.id));
      if (f) {
        rv.id = f.id;
        rv.revisionId = f.revisionId;
      }
      for (const i of rv.inputs)
        i.artifactId =
          artifacts.find((a) => a.path === i.artifactPath)?.id || null;
    }
    const feedback =
      sources.find((t) => t.comments) || sources.find((t) => t.metrics.length);
    const resolveOld = (id) =>
      artifacts.find((a) => a.legacyIds.includes(id))?.id || id;
    merged.push({
      ...def,
      edition: "选题工作区",
      revisions,
      artifacts,
      reviews,
      stages: [],
      metrics: (feedback?.metrics || []).map((m) => ({
        ...m,
        sourceId: resolveOld(m.sourceId),
      })),
      comments: feedback?.comments
        ? {
            ...feedback.comments,
            artifactId: resolveOld(feedback.comments.artifactId),
          }
        : null,
      directionSourceId:
        artifacts.find((a) => a.logicalUri === def.directionSource)?.id || null,
    });
  }
  c.topics = [...merged, ...c.topics.filter((t) => !used.has(t.id))];
  c.all = new Map(
    [...c.docs, ...c.topics.flatMap((t) => t.artifacts)].map((a) => [a.id, a]),
  );
  c.aliases = Object.fromEntries(
    c.topics.flatMap((t) =>
      t.artifacts.flatMap((a) => (a.legacyIds || []).map((id) => [id, a.id])),
    ),
  );
  return c;
}
