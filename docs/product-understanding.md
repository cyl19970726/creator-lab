# 产品认知：Agent Workflow 为什么这样构建

本组保存推导、反例、检验和修正判断的方法及理由。初次了解产品从 [产品全貌与任务导览](../vendor/agent-workflow/docs/documentation.md)开始；成形的目标、架构、交互和技术合同分别进入对应组，不必先通读六章。

[文档架构依据与实施记录](documentation-architecture.md)说明各组职责和原资产保留；[产品全貌](../vendor/agent-workflow/docs/documentation.md)是现行任务入口。

**我们正在构建一种让 Agent 的业务方法在真实工作中形成、接受检验、持续演化并稳定服务的工作范式。** 产品要让方法能够执行，让执行留下有用的事实，让评价支持判断，让判断改善后续方法，并让有效方法持续服务业务。工作台与 CLI／tool 分别是人与 Agent 参与这个过程的入口。

认知需要回答的不只是“我们有什么功能”，还包括：为什么做、为谁做、相信什么工作方式、方法怎样形成与演化、产品必须承担什么，以及什么证据会改变这些判断。这里保留连贯的推理，具体布局另见[产品设计](product-design/README.md)。

## 认知章节目录

| 章节 | 要理解的问题 | 向下一层交出什么 |
| --- | --- | --- |
| [目标与核心范式](product-understanding/goals-and-paradigm.md) | 宏观和微观目标是什么；用户连续请求背后在维护什么；为什么需要这种工作方式 | 价值、原则、边界和成功标准 |
| [方法形成与生命周期](product-understanding/lifecycle-and-methods.md) | 从零或历史形成方法，如何运行、评价、调优、采用、稳定服务再复盘；skill 与 Prompt＋tools 怎样参与 | 阶段之间的责任、产物与转换依据，两张完整过程图 |
| [场景、产品责任与对象](product-understanding/responsibilities-and-objects.md) | 谁在什么情境下作何判断；产品必须承担什么；Space、workflow、Case、资产与评价怎样相连 | 必要机制、对象边界和信息层级 |
| [判断、执行与证据](product-understanding/decisions-and-evidence.md) | 自主执行到哪里为止；证据支持什么断言；验证是否充分；采用怎样影响新业务 | 对象之间的决定规则、冲突状态与尚需验证的价值假设 |
| [调优与 Dogfood](product-understanding/learning-and-dogfood.md) | 哪些发现改善当前方法，哪些进入共享产品建设；阻塞与交付后复验怎样处理 | 两类改进的归属、依赖和回到业务的路径 |
| [认知审阅与验证](product-understanding/review-and-validation.md) | 怎样发现共同盲点、检查证据、组织 Agent review、用真实任务修正判断 | 关键假设、反例、证据与仍未解决的问题 |

这些章节属于同一份产品认知，拆页是为了定位和维护。左侧“认知方法与设计依据”可展开进入各章；“前端与交互设计”接续布局、线框、关键决定和场景走查。**文档目录按理解与决策依赖组织，产品导航按用户任务组织，两者不照搬。**

## 当前哪些结论成立，哪些还需验证

用户已明确：业务必须由 workflow 真实完成；完整生命周期是产品核心；节点可以使用 skill，也可直接迭代 Prompt＋tools 和已有执行器配置；共享存储、SDK 接入等项目缺口进入 dogfood issue；工作流标题应能展开二级任务；准确版本应能完整追溯其动机、方法、实际案例、评价和后继，关键资产应在图中表达；Agent 既通过 skill＋CLI 取证，也需要代用户真实使用前端。版本总评分机制尚待讨论。

我们据此提出的导航分组、默认主体、跨入口路径和决定规则仍是设计提案。本轮继续推导的主要缺口是：合同内自主怎样处理执行中才发现的问题；定义、实现和实际记录如何区分；资产关系支持多强的判断；实际使用与计划验证怎样对账；采用怎样真正影响未来委托。此前文档已有相应原则，具体连接和冲突处理尚不足。详见[判断、执行与证据](product-understanding/decisions-and-evidence.md)。

章节完整、多人同意和文档站构建成功，都不能证明这些安排容易使用或能够产生业务价值。成果是否可用、自主执行是否减少人工负担、新业务能否形成可用首版，仍需实际任务验证；不能由可追溯记录推定成立。

## 从认知进入设计

接下来按“责任与对象 → 判断及作用范围 → 信息层级 → 外壳与导航 → 各主体 → 连续任务走查”推导。当前[布局首稿](product-design/layout.md)围绕准确 workflow 版本组织设计目标、完整方法与预期产物、Case／run／资产关系、评价分析与后继版本，并通过版本遗传图谱解释演化；[关键决定与状态](product-design/decisions-and-states.md)落实主体中的证据、冲突与动作；[场景走查](product-design/walkthroughs.md)记录其检验方式和未验证项。

当前交付为[页面线框与推导原则](product-design/wireframes.md)：沿用 Archify 主画布及点击详情，把目标、版本、方法、Case／资产、评价和演化落实到各页内容与连续路径。用户已明确不需要继续制作可操作低保真。[历史原型走查](product-design/prototype-round.md)保留草案与委托关联等观察，但原型绕开既有 Archify 的形态未被接受，不能用其局部走查支持整体设计通过。后续仍需分别检验界面可理解、workflow 真执行与业务结果有用。

## 文档的权威边界

本目录解释依据、推导和假设；[产品定义](../vendor/agent-workflow/docs/product.md)维护正式目标与对象合同；[工作台定义](../vendor/agent-workflow/docs/workbench-presentation.md)维护交互要求；[建设状态](../vendor/agent-workflow/docs/harness-roadmap.md)维护当前实现事实。设计提案中的按钮、状态和动作不是已交付能力。文档之间的详细分工见[设计导览](product-design/README.md)。
