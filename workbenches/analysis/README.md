# 自媒体分析工作台

从现有 self-media 工作台迁移，保留单帖、单博主分析及关联证据/研究过程。使用 React 19、Vite、Express、SQLite；完整方法包位于 `.agents/skills/`。不包含多博主对比、知识 Wiki、发布或学习回路。单博主内部的跨帖综合、批量提交任务仍保留。

单帖主报告按 Builder 原文展示「内容还原、编导逻辑、画面与剪辑」。证据贴在结论旁；审阅、修订与工作流进度另外可达。当前入口 `/analyze` 查看已有单帖，从博主作品进入可重跑；旧 `/api/runs` 已退休，不是通用任意链接的单帖入口。

## 原核心阶段

以下按保留代码阶段绘制，不引入新产品流程。博主阶段来源：`packages/research/src/creator-research/service.ts`；单帖审阅阶段来源：`packages/research/src/workflows/simple-review.ts`。

```mermaid
flowchart LR
  A[身份与登录预检] --> B[全量作品清单] --> C[High / Base / Low 分层]
  C --> D[重点帖子内容还原] --> E[博主内容系统归纳] --> F[原工作台报告]
```

最后阶段原代码标签为「发布到原有 Dashboard」，意为交付研究报告，不是平台发帖。

```mermaid
flowchart LR
  A[来源一致性核对] --> B[候选构建] --> C[独立复核]
  C -->|无意见| E[登记候选与审阅状态]
  C -->|有意见| D[候选修订一次] --> E
```

复核技术失败保留候选并标明审阅不完整；修订版未复审不能继承原版审阅通过。博主综合使用冻结作品与单帖分析，再独立复核并按需修订。运行完成或测试通过不等于分析结论正确。

## 启动

在仓库根目录统一安装，Node.js 24、pnpm 10.28.2；共享执行代码只在根目录 `vendor/agent-workflow` 一份。

```sh
pnpm install
pnpm --filter @creator-lab/analysis dev
```

默认页面 `http://127.0.0.1:5173`，API `http://127.0.0.1:4310`。根目录可用 `pnpm --filter @creator-lab/analysis typecheck`、`test`、`build`、`smoke:entrypoints`；这些脚本会先构建共享执行包。

在本目录按 `.env.example` 配置。新研究的持久状态默认保存本目录 `.runtime`，不会读取或修改旧仓库。真实采集/分析需要已有 Codex 登录、`ego-browser` 登录态或 RedFox API 配置，以及 ffmpeg/ffprobe、Python、相关转写/OCR工具；未满足条件会有明确阻塞或缺失状态。生产模型保留原 Luna 默认及可配置覆盖，未在迁移时运行模型。

生产运行：先 `pnpm --filter @creator-lab/analysis build`，再 `pnpm --filter @creator-lab/analysis start`。可关闭内嵌worker并单独运行 `start:worker`；只查看材料必须使用下面的只读模式。

## 显式复用原数据

源码仓库不包含私人数据库、报告或媒体。查看已有结果时，先创建 SQLite 一致性备份，不直接复制活动数据库文件：

```sh
cd workbenches/analysis
python3 scripts/snapshot-runtime.py \
  --source /absolute/path/to/self-media/.runtime \
  --output /absolute/path/to/analysis-view-snapshot
SELF_MEDIA_RUNTIME_DIR=/absolute/path/to/analysis-view-snapshot \
SELF_MEDIA_READ_ONLY=true SELF_MEDIA_EMBED_WORKERS=false pnpm dev
```

备份只含数据库；`runs/` 为指向原报告/媒体的链接，没有复制大媒体。只读模式拒绝创建、重跑、取消等写请求并禁用worker，保护原资产；请保持该模式。证据仓库另通过 `SIGNAL_ROOM_EVIDENCE_ROOT` 指定。若要继续研究，使用独立可写runtime和独立完整资产副本，不能关闭查看快照的只读保护。

可通过 `/creators` 浏览博主，`/analyze` 浏览已有单帖，报告页提供关联 workflow 与 evidence。内容能否复述、证据是否支持结论仍须实际阅读判断；迁移检查仅证明接口与执行结构保持可用。
