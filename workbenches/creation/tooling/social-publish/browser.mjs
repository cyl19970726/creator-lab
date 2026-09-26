import fs from "node:fs";
import path from "node:path";
import { makeDOM } from "./dom.mjs";
import { description, norm, accountMatches, digest } from "./core.mjs";
import {
  publishPlan,
  configurePublication,
  auditPublication,
} from "./schedule.mjs";
const defaults = JSON.parse(
  fs.readFileSync(new URL("./adapters.json", import.meta.url)),
);

export function assertAudit(observed, job, platform) {
  const c = job.platforms[platform];
  if (
    norm(observed.title) !==
    norm(platform === "channels" ? c.short_title : c.title)
  )
    throw Error("标题回读不一致");
  if (
    norm(observed.caption).replace(/\[话题\]#/g, "") !==
    norm(description(job, platform) + c.tags.map((t) => "#" + t).join(""))
  )
    throw Error("正文/话题回读不一致");
  for (const key of [
    "upload",
    "cover",
    "ai",
    "visibility",
    "publication",
    "location",
    "titleAccepted",
  ]) {
    if (observed.checks[key] !== true)
      throw Error(`尚未核实：${key}，请校准当前页面对应控件`);
  }
  if (c.original && observed.checks.original !== true)
    throw Error("原创声明未核实");
  return digest(JSON.stringify(observed));
}

export async function createBrowserDriver(api, job, state, save, directory) {
  if (!job.browser?.profileId)
    throw Error("发布包缺少已确认的 browser.profileId");
  let task;
  if (state.space) {
    const spaces = await api.listTaskSpaces();
    const existing = spaces.find((s) => (s.spaceId ?? s.id) === state.space);
    if (!existing)
      throw Error("原发布空间已关闭；请核对旧草稿后恢复，不新建空间绕过状态");
    if (existing.profileId !== job.browser.profileId)
      throw Error("原空间 profile 与发布包不一致");
    if (existing.ownership !== "agent")
      throw Error("浏览器由用户控制，等待用户明确继续");
    task = await api.taskSpace(state.space);
  } else {
    const profiles = await api.profiles();
    if (!profiles.some((p) => (p.id ?? p.profileId) === job.browser.profileId))
      throw Error("找不到发布包指定的浏览器 profile");
    task = await api.taskSpace(`publish-${job.id}`, {
      profileId: job.browser.profileId,
    });
    state.space = task.spaceId;
    save();
  }
  let page;
  const recipe = (p) => ({ ...defaults[p], ...job.adapters?.[p] });
  const dom = async () =>
    makeDOM({
      cdp: (...args) => page.cdp(...args),
      click: ({ x, y }) =>
        page.mouse.click(x, y, { label: "操作当前发布控件" }),
      typeText: (text) => page.keyboard.insertText(text),
    });
  async function select(p, kind) {
    state.pages ??= {};
    const key = kind === "editor" ? `${p}-editor` : "inspection";
    if (kind !== "editor" && !state.pages.inspection)
      state.pages.inspection =
        state.pages[`${p}-account`] ||
        Object.entries(state.pages).find(([k]) => k.endsWith("-account"))?.[1];
    if (state.pages[key]) page = task.page(state.pages[key]);
    else {
      page = await task.newPage();
      state.pages[key] = page.label;
      save();
    }
    return page;
  }
  async function proof(label, fullPage = false) {
    fs.mkdirSync(directory, { recursive: true });
    const base = path.join(directory, `${label}-${Date.now()}`);
    fs.writeFileSync(base + ".txt", await page.snapshot());
    await page.screenshot({ path: base + ".png", fullPage });
    return {
      screenshot: base + ".png",
      sha256: digest(fs.readFileSync(base + ".png")),
      snapshot: base + ".txt",
      page: page.label,
      url: await page.url(),
      capturedAt: new Date().toISOString(),
    };
  }
  async function account(p) {
    await select(p, "account");
    await page.goto(recipe(p).accountUrl || recipe(p).home);
    const a = recipe(p);
    const d = await dom();
    for (const s of a.accountSteps || []) await d.click(s);
    try {
      await page.waitForFunction(
        (id) => {
          const roots = [document];
          let text = "";
          for (let i = 0; i < roots.length; i++) {
            text += roots[i].body?.innerText || roots[i].textContent || "";
            for (const e of roots[i].querySelectorAll("*"))
              if (e.shadowRoot) roots.push(e.shadowRoot);
          }
          return text.includes(id);
        },
        job.platforms[p].account.id,
        { timeout: 10000 },
      );
    } catch (e) {
      if (/user|用户|control|inactive|unassigned/i.test(e.message)) throw e;
    }
    const snapshot = await page.snapshot();
    const evidence = await proof(`${p}-account`);
    let matches = accountMatches(snapshot, job.platforms[p].account);
    if (a.accountName && a.accountId)
      matches =
        norm(await d.read(a.accountName)) ===
          norm(job.platforms[p].account.name) &&
        norm(await d.read(a.accountId)) === norm(job.platforms[p].account.id);
    if (!matches)
      throw Error(`${p} 账号未匹配名称和唯一 ID；证据：${evidence.screenshot}`);
    return evidence;
  }
  async function executeSteps(steps, assets, onStep) {
    for (const [index, step] of (steps || []).entries()) {
      const d = await dom();
      if (step.upload) {
        const chooser = page.waitForFileChooser({ timeout: 10000 });
        // Always consume the pending chooser rejection if clicking fails.
        chooser.catch(() => {});
        await d.click(
          typeof step.upload === "string" ? { text: step.upload } : step.upload,
        );
        await (await chooser).setFiles(assets[step.asset]);
      } else if (step.input)
        await page.setInputFiles(step.input, assets[step.asset]);
      else if (step.checkNear) {
        const id = await d.one({ text: step.checkNear });
        const checked = await d.call(
          id,
          `function(){let e=this;for(let i=0;e&&i<5;i++,e=e.parentElement){const a=e.querySelectorAll('input[type=checkbox]');if(a.length===1){if(!a[0].checked)a[0].click();return true}}return false}`,
        );
        if (!checked) throw Error("无法定位声明勾选框");
      } else if (step.click)
        await d.click({
          text: step.click,
          ...(step.selector ? { selector: step.selector } : {}),
        });
      else throw Error("未支持的步骤类型");
      await onStep?.(index);
    }
  }
  async function readCheck(d, check) {
    if (!check) return false;
    const id = await d.one(check.spec || { selector: check.selector });
    if (check.kind === "checked")
      return d.call(
        id,
        'function(){return this.checked===true||this.getAttribute("aria-checked")==="true"}',
      );
    if (check.kind === "enabled")
      return d.call(
        id,
        'function(){return !this.disabled&&this.getAttribute("aria-disabled")!=="true"}',
      );
    if (check.kind === "text")
      return (
        norm(
          await d.call(id, "function(){return this.value??this.innerText}"),
        ) === norm(check.equals)
      );
    throw Error("未知核对方式");
  }
  async function audit(p) {
    await select(p, "editor");
    const d = await dom(),
      a = recipe(p);
    await auditPublication(d, a, publishPlan(job, p));
    const checks = { publication: true };
    for (const key of [
      "upload",
      "cover",
      "ai",
      "visibility",
      "location",
      "titleAccepted",
      "original",
    ])
      checks[key] = await readCheck(d, a.checks?.[key]);
    const result = {
      title: await d.read({ selector: a.title }),
      caption: await d.read({ selector: a.editor }),
      checks,
    };
    assertAudit(result, job, p);
    return result;
  }
  return {
    account,
    async prepare(p, record, checkpoint) {
      const a = recipe(p);
      await select(p, "editor");
      // Never navigate a recovered editor away from an uploaded draft.
      if (!record.editorOpened) {
        await page.goto(a.editorUrl || a.home);
        if (!a.editorUrl) await (await dom()).click({ text: a.entry });
        record.editorOpened = true;
        checkpoint();
      }
      const missing = [
        "upload",
        "cover",
        "ai",
        "visibility",
        "location",
        "titleAccepted",
      ].filter((k) => !a.checks?.[k]);
      if (
        !a.uploadReady ||
        !a.publication?.[publishPlan(job, p).mode]?.selected ||
        missing.length
      )
        throw Error(
          "平台适配尚待校准：" +
            [
              ...missing,
              ...(!a.uploadReady ? ["uploadReady"] : []),
              ...(!a.publication?.[publishPlan(job, p).mode]?.selected
                ? ["publication"]
                : []),
            ].join(", ") +
            "。先在当前编辑页观察对应控件并写入 job.adapters；不重复上传试错",
        );
      const mediaFingerprint = digest(
        JSON.stringify({ video: job.videoHash, covers: job.coverHashes }),
      );
      if (
        record.fingerprint &&
        record.fingerprint !== job.fingerprint &&
        record.mediaFingerprint !== mediaFingerprint
      )
        throw Error("草稿绑定旧素材，需要明确清理旧草稿后重新准备");
      record.fingerprint = job.fingerprint;
      record.mediaFingerprint = mediaFingerprint;
      checkpoint();
      const assets = { video: job.video, cover: job.cover };
      for (const [name, value] of Object.entries(job.covers || {}))
        assets[name] = typeof value === "string" ? value : value.path;
      if (!record.videoUploaded) {
        if (record.uploadStarted) {
          if (await readCheck(await dom(), a.checks?.upload)) {
            record.videoUploaded = true;
            checkpoint();
          } else
            throw Error("上次上传被中断，先 inspect 核对页面，不自动再上传");
        }
        if (!record.videoUploaded) {
          record.uploadStarted = true;
          checkpoint();
          await page.setInputFiles(a.videoInput, assets.video);
          if (!a.uploadReady)
            throw Error("上传完成标志尚未校准；已上传，不会重复上传");
          await page.waitForSelector(a.uploadReady, { timeout: 60000 });
          record.videoUploaded = true;
          checkpoint();
        }
      }
      const d = await dom();
      await d.fill(
        { selector: a.title },
        p === "channels"
          ? job.platforms[p].short_title
          : job.platforms[p].title,
      );
      await d.fill(
        { selector: a.editor },
        description(job, p) +
          "\n\n" +
          job.platforms[p].tags.map((t) => "#" + t).join(" "),
      );
      if (!record.coverUploaded) {
        if (record.coverStarted) {
          if (await readCheck(await dom(), a.checks?.cover)) {
            record.coverUploaded = true;
            record.coverProof = await proof(`${p}-cover-recovered`);
            checkpoint();
          } else
            throw Error("封面步骤中断，先 inspect 核对当前弹窗，不盲目重复");
        }
        if (!record.coverUploaded) {
          record.coverStarted = true;
          checkpoint();
          await executeSteps(a.coverSteps, assets, (index) => {
            record.coverStep = index;
            checkpoint();
          });
          record.coverProof = await proof(`${p}-cover`);
          record.coverUploaded = true;
          checkpoint();
        }
      }
      if (!(await readCheck(await dom(), a.checks?.ai)))
        await executeSteps(a.aiSteps, assets);
      if (
        job.platforms[p].original &&
        !(await readCheck(await dom(), a.checks?.original))
      ) {
        if (!a.originalSteps) throw Error("原创声明尚未校准");
        await executeSteps(a.originalSteps, assets);
      }
      await executeSteps(a.settingsSteps, assets);
      await configurePublication(await dom(), a, publishPlan(job, p));
      return audit(p);
    },
    audit,
    async preview(p) {
      const observed = await audit(p),
        a = recipe(p);
      const frames = [];
      for (const time of a.previewTimes || [8, 178]) {
        const d = await dom();
        const videos = await d.find({ selector: "video" });
        if (videos.length !== 1)
          throw Error("需要唯一可见的视频预览，不能截取隐藏或旧画面");
        const target = Math.min(
          time,
          Math.max(0, (job.meta?.duration || time + 1) - 0.5),
        );
        await d.call(
          videos[0],
          `function(t){return new Promise((resolve,reject)=>{this.pause();const done=()=>{if(!this.seeking&&this.readyState>=2&&Math.abs(this.currentTime-t)<0.15){clearTimeout(timer);resolve(true)}};const timer=setTimeout(()=>reject(Error('视频新帧解码超时')),8000);if(Math.abs(this.currentTime-t)<0.15&&!this.seeking){done();return}if(this.requestVideoFrameCallback)this.requestVideoFrameCallback(done);this.addEventListener('seeked',()=>requestAnimationFrame(()=>requestAnimationFrame(done)),{once:true});this.currentTime=t;})}`,
          [target],
        );
        await d.call(
          videos[0],
          'function(){this.scrollIntoView({block:"center"})}',
        );
        frames.push({ time: target, ...(await proof(`${p}-frame-${time}`)) });
      }
      return { observed, frames, settings: await proof(`${p}-preview`, true) };
    },
    async inspect(p) {
      await select(p, "editor");
      return proof(`${p}-inspect`);
    },
    async submit(p) {
      await select(p, "editor");
      const a = recipe(p);
      await (
        await dom()
      ).click({
        text: a.publication?.[publishPlan(job, p).mode]?.publish || a.publish,
        selector: "button",
      });
      return proof(`${p}-after-click`);
    },
    async verify(p) {
      await account(p);
      await select(p, "list");
      const a = recipe(p);
      await page.goto(a.list);
      const evidence = await proof(`${p}-receipt`);
      if (!a.receiptRow)
        return {
          status: "submission-unconfirmed",
          evidence,
          reason: "需校准作品行，标题相同不足以确认当前版本",
        };
      const d = await dom();
      const rows = await d.find({ selector: a.receiptRow });
      const texts = await Promise.all(
        rows.map((id) => d.call(id, "function(){return this.innerText}")),
      );
      return { status: "submission-unconfirmed", evidence, rows: texts };
    },
    async finish() {
      await task.finish({ keep: [] });
    },
  };
}
