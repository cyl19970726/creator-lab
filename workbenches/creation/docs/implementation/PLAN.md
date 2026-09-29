# New creation platform — first implementation PR

Scope: P1 + P2 article vertical slice, using real agent-workflow; new UI/API/worker and fresh state. P3 video production and P5 method efficacy remain later milestones, explicitly unsupported in this PR. No old implementation compatibility. Preserve private data and the independent research/analysis workbenches.

Deliverables and ownership:
- Lead: shared contracts, tooling/config, native process lock, integration, real-run evidence, cleanup/docs/PR.
- Backend: SQLite business state + durable jobs, scoped API, worker/vendor integration, recovery and cancellation tests.
- Workflow: B1 definition + article author/reviewer/revision via vendor, bounded repair, validation, provenance, real Codex runner adapter and deterministic tests.
- Frontend: React workbench, real API wiring, create/start/read/feedback/revise/decide/cancel/resume, responsive accessible styling.

API convention: `/api/workspaces`, `/api/workspaces/:workspaceId/works`, `/api/works/:workId?workspaceId=...`, `/api/works/:workId/start|revise|decisions`, `/api/jobs/:jobId/cancel|resume`, `/api/jobs/:jobId/execution`. Scoped mutations use `?workspaceId=...`. JSON response is the corresponding contract entity (lists are arrays). Error `{error: string}`; 400 invalid, 404 inaccessible/missing, 409 stale/conflict. All mutations carry commandId; the same ID with different body/scope must conflict.

Runtime boundaries: new private state root, single OS-locked worker, no timeout takeover. API never invokes models. Immutable inputs per job; user feedback starts a related new run. Model and maximum revision calls explicit. Polling only reads. Mock runners only in tests and visibly labeled test fixtures; no silent simulation in the product.

Acceptance: typecheck/build; workflow author/reviewer/repair and exact review binding; API scope/input/idempotency/stale decision; actual process exclusion/crash release; job recovery and file/vendor/business reconciliation; UI-driven article loop; real model smoke where environment supports it; external reviewer pass before PR. Record limitations without claiming model quality or user acceptance.

## 实现与验证记录（2026-09-29）

当前交付为第一条文章路线，不代表设计报告全部里程碑完成。新代码使用 React/TypeScript/Vite、Fastify、SQLite 和独立 worker；实际流程通过共享 agent-workflow 的 agent/phase/validate/publish 执行。共享子模块保持 `347aff2e19136a4d2482ddfe8fc6da64460f954c`，无需修改研究与分析工作台。

已完成：
- 工作区、作品、冻结输入、内容定义、完整稿件、精确稿件审阅、有上限自动返工、用户意见关联新任务、版本选择/接受/退回。
- 单 worker OS 文件锁；run/job 同事务绑定；发布重放复用；文件、原生发布与业务登记恢复；取消与失败恢复。
- 原子写文件与残缺文件隔离：独立审阅发现此中断窗口后补实现、回归测试和定向复验。
- 失败的安全分类与改配置新执行入口；原运行记录保留，原始错误和调用轨迹不返回页面。
- 旧工作台、旧表达 CLI、空清单和目录占位退出；旧私有材料未删除、未自动导入。
- B1 方法补充需求、注意力信号、已有解释与内容空缺的证据区分；没有输入时保留未知，不伪造调研。此方法修订并不等于跨题有效性已获验证。

验证：
- Node 24 下共享 workflow 包构建通过。
- Creation 类型检查、26 项自动化测试、前端生产构建通过。覆盖 scope、幂等、版本哈希、审阅绑定、取消/恢复、中断物化、原生发布复用、OS 进程暂停/退出锁语义及错误脱敏。
- 保留的独立发布工具 28 项测试通过；未进行平台发布。
- 浏览器实际创建工作区和作品、输入材料、发起执行、处理不可用模型后改配置新建执行。桌面 1440px 与窄屏 390px 无整页横向溢出，截图已检查。
- 设计报告重新生成：6 张图，本地链接及锚点无缺失、无重复 ID。
- 真实 SDK 环境拒绝 `gpt-6-sol` 与 `gpt-5.4`；采用已向用户披露的 `gpt-5.5` / low / 0 次自动修订完成首稿及独立审阅。失败记录和真实产物均留在被忽略的私有验收目录。
- 浏览器提交精确初稿反馈后，真实 SDK 完成第二版和重新审阅；两次成功运行各有 definition/draft/review，共 6 份资产。API/worker 重启后继续修订，刷新重新打开作品后仍可读取两稿、父版本关系和第二版选择记录。验收仅登记 `select`，没有替用户登记内容接受或发布授权。

仍未覆盖：视频/音频制作、发布接入、历史数据导入、主动市场扫描、B1 独立人工选定与回退编辑界面、跨目的方法效果比较、多机 worker、Windows/NFS。文章完整成品检查与写作合并执行；这不等于独立的视频 B3 已完成。模型审阅 pass 也不代表实际用户接受。

首稿真实运行使用 B1 方法补充前的冻结包；反馈修订使用本 PR 最终方法包。B1 新增的需求判断还需有真实受众/同题材料的案例评估，不能用虚构软件规则题证明市场判断质量。


已观察到的非阻断限制：审阅文本语言由模型输出，本次修订审阅为英文，页面保留原结论；后续可收紧输出语言。刷新后回到作品总览，需要重新选择作品；数据与稿件选择记录仍持久保留。
