import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readJob, platforms, atomicJSON } from "./core.mjs";
import { importReleasePackage } from "./pack.mjs";
import { createLedger } from "./ledger.mjs";
import { publishPlan } from "./schedule.mjs";
import { run } from "./runtime.mjs";
const [cmd, file, third, fourth] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
if (cmd === "test") {
  const files = fs
    .readdirSync(here)
    .filter((f) => f === "test.mjs" || f.endsWith(".test.mjs"))
    .map((f) => path.join(here, f));
  const r = spawnSync(process.execPath, ["--test", ...files], {
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
} else if (cmd === "pack") {
  if (!third) throw Error("用法：pack PACKAGE.json OUTPUT_DIR [RELEASE.json]");
  const out = path.resolve(third);
  if (fs.existsSync(out))
    throw Error("输出目录已存在，请使用新目录，避免覆盖已冻结发布包");
  const j = importReleasePackage(file, fourth);
  fs.mkdirSync(out, { recursive: true });
  atomicJSON(path.join(out, "job.json"), j);
  const checked = readJob(path.join(out, "job.json"));
  createLedger().syncJob(checked);
  fs.writeFileSync(
    path.join(out, "发布包.md"),
    `# ${j.platforms.douyin.title}\n\n同一内容：${j.deliveryId}\n\n${platforms.map((p) => `## ${p}\n\n账号：${j.platforms[p].account.name} / ${j.platforms[p].account.id}\n\n标题：${j.platforms[p].title}\n\n${j.platforms[p].publishBody}\n\n历史状态：${j.alreadyPublished[p]?.status || "未提交"}\n`).join("\n")}\n本次导入保留历史回执，不能用于重发。封面比例导出请使用 covers。\n`,
  );
  console.log({
    job: path.join(out, "job.json"),
    report: path.join(out, "发布包.md"),
    fingerprint: checked.fingerprint,
  });
} else if (cmd === "covers") {
  const { exportCovers } = await import("./covers.mjs");
  const job = readJob(file);
  const out = path.resolve(third);
  const result = await exportCovers(job, out);
  const next = { ...job, covers: { ...job.covers } };
  for (const v of result.variants) {
    next.covers[v.ratio === "3:4" ? "portrait" : "landscape"] = {
      path: v.path,
      sha256: v.sha256,
      width: v.width,
      height: v.height,
    };
  }
  next.cover = next.covers.portrait.path;
  delete next.coverSource;
  delete next.coverSources;
  const nextFile = path.join(out, "job-with-covers.json");
  atomicJSON(nextFile, next);
  console.log({ ...result, job: nextFile });
} else if (cmd === "check") {
  const j = readJob(file);
  console.log(
    JSON.stringify(
      {
        id: j.id,
        deliveryId: j.deliveryId,
        ...j.meta,
        browser: j.browser,
        validation: j.validation,
        platforms: platforms.map((p) => ({
          platform: p,
          account: j.platforms[p].account,
          publication: publishPlan(j, p),
          title: j.platforms[p].title,
          short_title: j.platforms[p].short_title,
          ai: j.platforms[p].ai,
          original: j.platforms[p].original,
        })),
        fingerprint: j.fingerprint,
      },
      null,
      2,
    ),
  );
} else if (cmd === "review" || cmd === "status")
  await run({}, [cmd, file, third, fourth], readJob(file));
else
  console.log(`五步发布工具（项目内）
1 pack PACKAGE.json OUT_DIR [RELEASE.json]  导入冻结素材、文案、账号及历史回执
  check JOB.json                          检查素材、指纹、字段
2 covers JOB.json OUT_DIR                 导出 3:4 / 4:3 封面与审核索引
3 probe JOB.json                          三平台只读核对账号
  prepare JOB.json PLATFORM               填写上传，记住进度，不提交
4 preview JOB.json PLATFORM               实际视频新帧与设置截图
  review JOB.json PLATFORM REVIEW.json    记录执行者/独立reviewer的实际核对
5 submit JOB.json PLATFORM                重新回读后仅提交一次，写入回执
  verify JOB.json PLATFORM                只读补齐或核对回执
  status JOB.json                         查看三平台状态
  inspect JOB.json PLATFORM               查看中断页面和截图
  resume JOB.json                         用户明确继续后恢复原空间
  finish JOB.json                         任务完成后关闭验证空间
  test                                   离线回归测试
使用 ./publish <命令>；PLATFORM: douyin / xiaohongshu / channels。
新内容使用 README 的 job 模板；已提交内容用于回放验证，绝不自动重发。
当前平台适配遇到未校准字段会停在相应步骤，并保存证据。`);
