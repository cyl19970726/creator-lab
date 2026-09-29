# 创作工作台

当前首版提供文章创作闭环：建立账号工作区和作品，定义内容、写完整文章、对精确稿件独立复核，必要时在设定上限内自动修订；用户再选择、接受、退回或提出新一轮修订意见。B1 内容定义与 B2 文章表达由真实 `agent-workflow` 运行，API 不直接调用模型。B3 视频制作、发布与反馈尚未接入这个新平台。真实 SDK 首稿已跑通，环境与后续验证结果见实施记录；单题运行和模型自审不代表内容方法质量已验证。

[产品与架构设计](docs/workflows/creation-platform-design.md) · [本轮实施范围](docs/implementation/PLAN.md) · [产物与 API 合同](docs/contracts/artifacts-and-review.md)

## 本地启动

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

## 当前工作方式与数据

页面可创建工作区和文章作品，填写核心问题、读者、目的、账号定位、约束与材料正文；材料链接只记录出处，不自动抓取网页。运行会冻结当次输入，并产生内容定义、文章草稿和绑定该稿的复核产物。复核未通过且修订预算耗尽时，任务进入 `needs_review`；它不是接受决定。用户意见会基于指定稿件及其哈希创建关联的新任务，不覆盖旧稿。执行失败可恢复同一个任务；取消与恢复状态见[合同](docs/contracts/artifacts-and-review.md)。

私有状态目录包含 `creation-v1.sqlite`、`artifacts/`、`traces/` 和 `worker.lock`。SQLite 保存业务对象及 vendor 原生运行账本；`artifacts/` 保存按哈希核验的内容，`traces/` 保存模型调用轨迹。备份或搬迁时应保留整套私有状态，并在进程停止后使用一致的 SQLite 备份方式；不要只复制单个正在写入的数据库文件。该目录被 Git 忽略。旧作品、旧数据库、旧 UI/API/CLI/schema 不会自动导入或兼容。

现有 `tooling/social-publish` 是独立的历史发布工具，未接入新 UI 或文章执行；项目内九个视频 skill 作为历史方法资料保留，不表示 B3 已实现。根目录的 `vendor/agent-workflow` 是唯一共享执行库，本工作台没有复制其引擎。可用 `pnpm --filter @creator-lab/creation check` 运行本工作台的类型检查、测试与构建；这些检查不替代真实模型或人工内容验收。
