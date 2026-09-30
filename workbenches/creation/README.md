# 创作工作台

两条产品线，共用根目录的 agent-workflow：

- **阶段 workflow（主线）：** 竖屏视频的 B1 定题 → B2 成稿 → B3 成片。内容由 workflow 里的 Agent 产出，每个阶段停在创作者关口，阶段之间用作品档案交接。以命令行 + 生成的静态页面运行，已在一个真实题目上调优到可用（B1 v7、B2 v7、B3 v9）。从 [创作文档导览](docs/README.md) 开始读，命令见[调优手册](docs/05-tuning.md#命令)。
- **文章应用：** 建立账号工作区和作品，定义内容、写完整文章、对精确稿件独立复核，必要时在设定上限内自动修订；用户再选择、接受、退回或提出新一轮修订意见。网页 + API + 独立 worker，下文是它的启动方式。接口见[文章应用合同](docs/03-architecture/article-app.md)。真实 SDK 首稿已跑通；单题运行和模型自审不代表内容方法已验证。

## 文章应用：本地启动

使用 Node 24，在仓库根目录运行：

```sh
pnpm install
pnpm build:workflow
pnpm --filter @creator-lab/creation build
pnpm --filter @creator-lab/creation dev
```

构建后的页面由 API 在 `http://127.0.0.1:4337` 提供。另开终端启动执行器，排队任务才会真正运行：

```sh
pnpm --filter @creator-lab/creation worker
```

改前端时，可另开终端运行 `pnpm --filter @creator-lab/creation dev:web`，访问 `http://127.0.0.1:4338`；Vite 将 `/api` 转发到 4337。`CREATION_PORT` 可更改 API 端口，默认 4337；前端开发代理目前固定指向 4337。API 和 worker 必须使用同一个 `CREATION_STATE_ROOT`，默认是 `workbenches/creation/data/local/platform-v1`。worker 用 `fs-ext` 的 OS 文件锁保证同一状态目录只由一个进程执行；目前要求 POSIX 本地文件系统，安装 `fs-ext` 需要可用的原生编译环境。

启动前需让运行环境具备所选模型的 Codex SDK 凭据。创建工作区或作品不会调用模型；在页面明确输入模型、推理强度及最多 0–2 次自动修订并点击开始后，worker 才会运行。缺少 worker 时任务保持排队。API 只绑定本机回环地址，不应作为公网服务部署。

## 文章应用：工作方式与数据

页面可创建工作区和文章作品，填写核心问题、读者、目的、账号定位、约束与材料正文；材料链接只记录出处，不自动抓取网页。运行会冻结当次输入，并产生内容定义、文章草稿和绑定该稿的复核产物。复核未通过且修订预算耗尽时，任务进入 `needs_review`；它不是接受决定。用户意见会基于指定稿件及其哈希创建关联的新任务，不覆盖旧稿。执行失败可恢复同一个任务；取消与恢复状态见[合同](docs/03-architecture/article-app.md)。

私有状态目录包含 `creation-v1.sqlite`、`artifacts/`、`traces/` 和 `worker.lock`。SQLite 保存业务对象及 vendor 原生运行账本；`artifacts/` 保存按哈希核验的内容，`traces/` 保存模型调用轨迹。备份或搬迁时应保留整套私有状态，并在进程停止后使用一致的 SQLite 备份方式；不要只复制单个正在写入的数据库文件。该目录被 Git 忽略。旧作品、旧数据库、旧 UI/API/CLI/schema 不会自动导入或兼容。

现有 `tooling/social-publish` 是独立的历史发布工具，未接入新 UI、文章执行或阶段 workflow；项目内九个视频 skill 作为历史方法资料保留，B3 成片由阶段 workflow 实现（`src/stages/b3.ts`）。根目录的 `vendor/agent-workflow` 是唯一共享执行库，本工作台没有复制其引擎。可用 `pnpm --filter @creator-lab/creation check` 运行本工作台的类型检查、测试与构建；这些检查不替代真实模型或人工内容验收。
