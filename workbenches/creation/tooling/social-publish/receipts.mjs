import { norm } from "./core.mjs";
import { verifyScheduledEvidence, publishPlan } from "./schedule.mjs";
export function reconcileReceipt(result, job, platform, record) {
  if (!record.attemptedAt && !record.publishAttempt?.startedAt)
    return {
      ...result,
      status: "submission-unconfirmed",
      reason: "缺少本轮提交时间",
    };
  const attempted = Date.parse(
    record.attemptedAt || record.publishAttempt.startedAt,
  );
  const title = job.platforms[platform].title;
  const plan = publishPlan(
    {
      publication:
        record.publication ||
        job.platforms[platform].publication ||
        job.publication,
    },
    platform,
  );
  const expectedTime =
    plan.mode === "scheduled" ? Date.parse(plan.at) : attempted;
  const rows = (result.rows || []).filter((row) =>
    norm(row).includes(norm(title)),
  );
  const matches = rows.filter((row) => {
    const date = row.match(
      /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?\s*(\d{1,2}):(\d{2})/,
    );
    if (!date) return false;
    const [, y, m, d, h, min] = date;
    const at = Date.parse(
      `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${min}:00+08:00`,
    );
    const withoutDates = row.replace(
      /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?\s*\d{1,2}:\d{2}(?::\d{2})?/g,
      "",
    );
    const times = [
      ...withoutDates.matchAll(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/g),
    ].map((x) => Number(x[1]) * 60 + Number(x[2]));
    return (
      Math.abs(at - expectedTime) <=
        (plan.mode === "scheduled" ? 0 : 10 * 60000) &&
      times.some((t) => Math.abs(t - job.meta.duration) < 2)
    );
  });
  if (matches.length !== 1)
    return {
      ...result,
      status: "submission-unconfirmed",
      reason: "没有唯一匹配标题、提交时间、时长的作品行",
    };
  const row = matches[0];
  if (plan.mode === "scheduled") {
    verifyScheduledEvidence(plan, row);
    return { ...result, status: "scheduled", matchedRow: row };
  }
  if (/审核中|原创审核中/.test(row))
    return { ...result, status: "reviewing", matchedRow: row };
  if (/已发布|发布成功/.test(row))
    return { ...result, status: "submitted", matchedRow: row };
  return {
    ...result,
    status: "submission-unconfirmed",
    reason: "作品行存在，尚缺明确提交状态",
    matchedRow: row,
  };
}
