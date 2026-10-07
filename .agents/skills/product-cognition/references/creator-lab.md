# Creator Lab 项目入口与维护边界

本 skill 位于仓库根目录 `.agents/skills/product-cognition/`，仅在本项目使用。源产品仍由现有文档维护，本文件不复制实时能力清单。

从仓库根目录读取：

- `AGENTS.md`：三个工作台独立、共享库归属和技能范围。
- `vendor/agent-workflow/docs/product.md`：业务目的、角色场景、对象和产品边界。
- `vendor/agent-workflow/docs/workbench-presentation.md`：现行入口、默认视图和交互。
- `vendor/agent-workflow/docs/harness-roadmap.md`：唯一当前实现状态。实施记录中的旧通过不替代它。
- `vendor/agent-workflow/docs/architecture.md`：共享能力与业务扩展的职责。
- `workbenches/creation/docs/README.md`：CONTENT、制作与交付等业务材料和接入入口。

需要理解 agent-workflow 的核心范式时，继续读共享 `docs/designing-workflows.md`、`docs/tuning-loop.md`、`docs/optimizing-workflows.md` 和 `docs/codex-and-skills.md`。恢复“意图或历史→阶段/步骤/资产→合同内自主执行→评价归因→候选与验证→稳定服务→反馈”的因果链，并说明 skill、工具和 harness 分工。产品认知不应只取前端抱怨作为分析范围。

调优的上层对象是候选执行方案。它可以改变流程结构、skill、Prompt＋tools、上下文、Codex／Agent SDK 执行器或基础设施，也可以组合变化；不要把所有候选都收窄为 skill。知识包、节点配置与运行环境各有责任，实际有效配置及条件变化须可追溯，效果需要真实业务验证。

按实际问题选择阅读，不要求每次全读。当前状态有争议时回到相关产物、代码或运行现场，注明核对时点。

`docs/product-understanding.md` 先独立说明这一项目的深层产品认知，再给出整体设计推导与取舍；更新现行事实时同时核对上述权威入口，避免新增平行路线图。公开项目文档不写私有稿件、原始trace、数据库内容或凭证。

已有 `workbenches/analysis/.agents/skills/reader-led-workflow/` 擅长从实际成果形成认知和行动，本 skill 补充产品设计前的场景推演及整体关系。只有需要更具体的使用与生产分工时再读它，不强制每轮同时加载两套流程。

工作流业务执行与评价是产品内的一层；负责理解产品、选择改进方向和使用交付的认知 Agent 是另一层。两层的证据可以关联，职责不能互相冒充。局部技术故障不自动改变产品主线，内容质量实验也不能自动取代产品完整性建设。
