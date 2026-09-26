// Scheduling is an absolute instant, never a delay re-evaluated during retries.
export function publishPlan(job, platform) {
  const plan = job.platforms?.[platform]?.publication ??
    job.publication ?? { mode: "immediate" };
  if (!["immediate", "scheduled"].includes(plan.mode))
    throw Error("publication.mode 必须是 immediate 或 scheduled");
  if (plan.mode === "immediate") {
    if (plan.at) throw Error("立即发布不能同时指定定时时间");
    return { mode: "immediate" };
  }
  if (
    typeof plan.at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      plan.at,
    ) ||
    !Number.isFinite(Date.parse(plan.at))
  )
    throw Error("定时必须指定含时区、精确到分钟的 ISO 时间");
  const t = new Date(plan.at);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(t)
      .map((x) => [x.type, x.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`,
    time = `${parts.hour}:${parts.minute}`;
  return {
    mode: "scheduled",
    at: t.toISOString(),
    timeZone: "Asia/Shanghai",
    date,
    time,
    local: `${date} ${time}`,
  };
}
export function assertFuture(plan, now = Date.now()) {
  if (plan.mode === "scheduled" && Date.parse(plan.at) <= now)
    throw Error("定时时间已过；不得改成立即发布或自动顺延");
}
export function assertPlatformWindow(plan, recipe, now = Date.now()) {
  assertFuture(plan, now);
  if (plan.mode !== "scheduled") return;
  const minutes = (Date.parse(plan.at) - now) / 60000;
  const limits = recipe.schedulingLimits || {};
  if (limits.minLeadMinutes !== undefined && minutes < limits.minLeadMinutes)
    throw Error("平台要求更长的定时提前量；请用户重新指定时间，不自动顺延");
  if (limits.maxLeadMinutes !== undefined && minutes > limits.maxLeadMinutes)
    throw Error("定时时间超过平台允许范围");
}
export function fieldValue(plan, format) {
  const values = {
    date: plan.date,
    time: plan.time,
    datetime: plan.local,
    "datetime-local": `${plan.date}T${plan.time}`,
  };
  if (!values[format]) throw Error("未知定时字段格式");
  return values[format];
}
function adapterFor(recipe, plan) {
  const a = recipe.publication?.[plan.mode];
  if (!a?.selected)
    throw Error("发布方式控件尚未校准：必须提供可回读的 selected 选择器");
  if (plan.mode === "scheduled" && !a.fields?.length)
    throw Error("定时时间字段尚未校准");
  return a;
}
export async function auditPublication(d, recipe, plan) {
  assertPlatformWindow(plan, recipe);
  const a = adapterFor(recipe, plan);
  const selected = await d.call(
    await d.one({ selector: a.selected }),
    'function(){return this.checked===true||this.getAttribute("aria-checked")==="true"||this.getAttribute("aria-selected")==="true"}',
  );
  if (!selected) throw Error("发布方式未选中，禁止提交");
  for (const f of a.fields || []) {
    const actual = String(await d.read({ selector: f.selector })).trim();
    if (actual !== fieldValue(plan, f.format))
      throw Error(`定时回读不一致：${actual}`);
  }
}
export async function configurePublication(d, recipe, plan) {
  assertPlatformWindow(plan, recipe);
  const a = adapterFor(recipe, plan);
  if (a.select) await d.click(a.select);
  for (const f of a.fields || [])
    await d.fill({ selector: f.selector }, fieldValue(plan, f.format));
  if (a.confirm) await d.click(a.confirm);
  await auditPublication(d, recipe, plan);
}
export function verifyScheduledEvidence(plan, text) {
  if (plan.mode !== "scheduled") return;
  const normalized = text
    .replace(/\//g, "-")
    .replace(/年|月/g, "-")
    .replace(/日/g, "");
  if (
    !/定时|待发布|预约/.test(text) ||
    !normalized.includes(plan.date) ||
    !normalized.includes(plan.time)
  )
    throw Error("未找到该作品的定时状态和准确时间，不能认定预约成功");
}
