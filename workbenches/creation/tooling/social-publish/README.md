# 五步视频发布

发布包准备 → 封面按比例导出 → 三平台填写与上传 → 预览核对 → 提交及回执。

同一账号身份共用内容与素材，三个平台分别保存文案、封面、页面进度和回执。这里负责发布执行，不重做账号工作区或内容生产流程。

**当前验证范围**：发布包、比例导出、提交账本和中断防重已做离线测试；当前 ego TaskSpace/Page 浏览器接口用本地模拟页面验证，三平台账号做真实只读核对。`adapters.json` 中仍标为 `requires-current-editor-verification` 的上传状态、声明及封面弹窗，须在下一次真实未发布内容的编辑页逐项校准；不把旧发布 trace、模拟页面或单元测试称为脚本完成真实三平台发布。

## 1. 发布包准备

已有本期冻结包可直接导入，保留历史回执：

```bash
./tooling/social-publish/publish pack \
  episodes/deepseek-v4-flash-workbench-next-20260910/release-20260911/package.json \
  work/my-publish-import
./tooling/social-publish/publish check work/my-publish-import/job.json
./tooling/social-publish/publish status work/my-publish-import/job.json
```

生成一个 `job.json` 和可读的 `发布包.md`。包包含真实账号、视频/字幕/封面路径与指纹、各平台完整文案。素材与回执版本不符会拒绝导入。当前 DeepSeek 三平台均有提交记录，不能用来再次上传或发表。

新内容创建独立 `job.json`：复用同账号信息，填写稳定的 `content` 或 `deliveryId`、本期已接受素材、平台文案，以及实际确定的 AI/原创/发布时间。`id` 只标识执行任务，`deliveryId` 标识内容，不因改标题或重编码而改变。不要复制历史 `alreadyPublished` 为新作品背书，也不要删除它来重发旧作品。

```json
{
  "id": "token-next-episode",
  "content": "token-next-episode",
  "browser": { "profileId": "Profile 3", "profileName": "token 经济猫" },
  "video": "/absolute/path/accepted.mp4",
  "cover": "/absolute/path/accepted-cover.png",
  "publication": { "mode": "immediate" },
  "platforms": {
    "douyin": {
      "account": { "name": "Token经济猫", "id": "73995666719" },
      "title": "本期题名",
      "body": "本期说明",
      "tags": ["AI算力"],
      "ai": true,
      "original": false
    },
    "xiaohongshu": {
      "account": { "name": "Token经济猫", "id": "94383437142" },
      "title": "本期题名",
      "body": "本期说明",
      "tags": ["AI算力"],
      "ai": true,
      "original": false
    },
    "channels": {
      "account": { "name": "Token经济猫", "id": "sphbrnpphDZvPrK" },
      "title": "本期题名",
      "short_title": "短标题",
      "body": "本期说明",
      "tags": ["AI算力"],
      "ai": true,
      "original": false
    }
  }
}
```

模板声明只是结构示例，应按本期事实和原有授权填写。小红书不再按 Unicode 20 字硬截标题；填写后必须回读真实平台反馈。视频号完整标题放正文首行，短标题单独填写。

## 2. 封面按比例导出

```bash
./tooling/social-publish/publish covers JOB.json NEW_COVER_DIR
```

产出 1080×1440 的 3:4、1440×1080 的 4:3、预览页及尺寸/指纹清单。来源可用 `coverSource` 指定 SVG 和字体；`coverSources["3:4"]`、`coverSources["4:3"]` 支持分别设计的源。未提供专门横版时完整等比放入画布，不裁切文字；这是保底导出，不等于优秀横版设计。输出目录必须全新，原稿不能被覆盖。

工具同时生成 `job-with-covers.json`，自动引用两种比例。检查 `preview.html` 后，后续使用这个新包；也可按以下结构引用专门设计的封面：

```json
{
  "covers": {
    "portrait": { "path": "/absolute/cover-3x4.png", "sha256": "实际hash" },
    "landscape": { "path": "/absolute/cover-4x3.png", "sha256": "实际hash" }
  }
}
```

抖音两个封面入口分别引用 portrait/landscape。小红书和视频号按当前预览使用已确认比例。重新导出会改变包指纹，旧预览审核不能沿用。不要改已经提交的冻结包来代替下一期设计。

## 3. 三平台填写与上传

```bash
./tooling/social-publish/publish probe JOB.json
./tooling/social-publish/publish prepare JOB.json douyin
```

其他平台依次使用 `xiaohongshu`、`channels`。整个任务只用一个 ego TaskSpace；不接管旧的已完成发布空间。`probe` 核对名称和唯一 ID；`prepare` 填写完整标题、正文和话题、上传对应封面并记录每个平台完成到哪一步。

平台有弹窗/控件变化时，运行 `inspect` 读取当前页面；执行 Agent 用实际 DOM 校准 `job.adapters.PLATFORM`，然后继续同一任务。无需再次要求用户授权原本已授权的发布。登录、扫码、用户控制浏览器时才暂停等待用户处理。

适配配置包含 `videoInput`、`uploadReady`、`coverSteps`、`aiSteps`、`settingsSteps`、`publication` 和 `checks`。每个 check 绑定实际可见元素：

```json
{
  "checks": {
    "visibility": { "kind": "checked", "selector": "当前页实际公开选项" },
    "location": {
      "kind": "text",
      "selector": "当前页实际位置摘要",
      "equals": "不显示位置"
    }
  }
}
```

`checks` 必须核实 upload、cover、ai、visibility、location、titleAccepted；开启原创时还核实 original。支持 kind=checked/text/enabled。选项标签出现不等于已选中；要定位状态控件或已选摘要。不会对未知选择器循环上传来试错。未校准时应先补映射，再上传。

`publication.immediate.selected` 回读立即发布的实际选中状态；定时沿用 `schedule.mjs`，需要绝对时间、准确日期和时区，以及已校准的日期控件。定时时间过期不转为立即发布。

## 4. 预览核对

```bash
./tooling/social-publish/publish preview JOB.json douyin
./tooling/social-publish/publish review JOB.json douyin PATH_TO_REVIEW.json
```

预览保存已解码的视频画面和设置截图，生成未勾选的审核文件。执行 Agent 或独立 reviewer 实际看完，填写 reviewer、notes 和封面/布局/字幕/设置结果后导入；这是记录检查，不是向用户再要一次发布权限。时间点可按内容在 `previewTimes` 配置，不应机械固定两帧就声称全片无问题。

审核绑定发布包指纹、预览及图片指纹；改素材、文案、适配或页面设置后需重新核对。下一期的布局在内容设计阶段确定，首次样片检查三平台真实播放视图；发布阶段只检查是否与已接受设计一致。

## 5. 提交及回执

```bash
./tooling/social-publish/publish submit JOB.json douyin
./tooling/social-publish/publish verify JOB.json douyin
```

提交前重新核对账号和页面字段，持久化提交尝试后点击一次。项目级 `.publish/ledger.json` 按内容+平台+真实账号防重，同视频换任务名也不能绕过。若点击后断线，状态保留提交中/结果待核对，后续只查作品列表。

回执应定位唯一作品行，匹配完整标题、提交时间、时长与平台状态。仅标题相同、跳转成功、按钮消失不算当前版本提交成功。平台没显示足够信息时保留证据供执行 Agent 核对，不猜测公开状态；`reviewing` 与 `published` 分开。

`inspect` 保存中断页；`resume` 仅在用户明确继续后取回同一空间。完成验证后 `finish` 关闭本任务空间一次。

## 验证与恢复

```bash
./tooling/social-publish/publish test
```

测试覆盖跨任务/改标题/重编码防重、并发提交竞争、点击后中断、预览后字段变化、旧同名作品、实际封面导出和保留原稿。`browser-fixture.mjs` 为绑定 127.0.0.1 的本地浏览器契约测试，不会向平台提交。

本地状态和账本包含发布回执，应随工作区备份；它们不是平台服务端幂等接口。删除账本、复制整个工具到另一台机器或人为换内容身份且换视频，会丢失本地防重依据，恢复后先导入真实回执。锁残留时确认进程已退出再移除，不能用新任务绕开未决提交。
