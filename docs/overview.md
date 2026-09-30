# 三个工作台

研究、分析、创作各自独立，没有必经的先后顺序。研究与分析保留迁入时的流程；创作按新的阶段 workflow 重建。

## 创作工作台

B1 定题 → B2 成稿 → B3 成片。每个阶段由 workflow 里的 Agent 完成，停在创作者关口；阶段之间用作品档案交接。详见[创作文档](../workbenches/creation/docs/README.md)。

```mermaid
flowchart LR
  IN[选题机会 · 账号 · 参照作品 · 材料] --> B1[B1 定题<br/>内容决定]
  B1 --> H1((创作者)) --> B2[B2 成稿<br/>完整稿]
  B2 --> H2((创作者)) --> B3[B3 成片<br/>视频 · 快照]
  B3 --> H3((创作者)) --> PUB[发布 → 数据<br/>未接入]
  H1 & H2 & H3 -. 意见写回 .-> S[(标准卡)]
  PUB -. 数据回流 未实现 .-> B1
```

技术栈：TypeScript，阶段 workflow 以命令行 + 生成的静态页面运行；文章应用为 React / Vite、Fastify API 与独立 worker。

## 研究工作台

沿用 research-workbench：研究问题、来源、图文报告、意见与修订。技术栈：React / Vite、Fastify、SQLite、独立 worker。详见[研究工作台](../workbenches/research/README.md)。

```mermaid
flowchart LR
A["A1 对齐目的<br/>任务书与核心问题"] --> B["A2 分题研究与综合<br/>证据、机制、最新变化、缺口"]
B --> C["A3 架构、图文与审阅<br/>详细报告、解释图、复验"]
C --> U["用户审阅<br/>接受具体版本与范围"]
C -->|研究不足| B
U -->|研究意见| B
U -->|表达意见| C
```

<details><summary>研究角色与方法</summary>

```mermaid
flowchart TB
M["主编 Agent · 对齐目标<br/>research-report-workflow<br/>交出：任务书与核心问题"]
M --> E["实证研究 Agent<br/>research-evidence-synthesis<br/>交出：来源、日期、状态与未知"]
M --> N["机制研究 Agent<br/>research-mechanism-analysis<br/>交出：因果、推导与假设"]
E <-->|交换发现与疑问| N
E --> S["主编 · 综合认知<br/>research-report-workflow<br/>交出：核心回答、依据、冲突与缺口"]
N --> S
S --> R["独立审核 Agent · 成稿依据<br/>research-report-review · foundation<br/>交出：审核发现与补证要求"]
R -->|缺口返回研究| S
R -->|依据充分| W["架构与图文 Agent<br/>research-report-architecture<br/>research-report-composition<br/>交出：架构、报告 v1、图与依赖"]
W --> Q["独立读者 Agent<br/>research-reader-questioner<br/>交出：复述、理解问题与复读结果"]
W --> V["独立审核 Agent · 定稿<br/>research-report-review · final<br/>交出：绑定版本的事实与因果问题"]
Q --> C["作者修改 · 审阅者复验<br/>各自沿用对应 Skill<br/>交出：报告 v2、修改记录与复验结果"]
V --> C
C --> U["用户审阅<br/>留下：对具体版本与范围的意见或接受"]
U -.->|重大研究意见| S
```

</details>

## 分析工作台

沿用 self-media：单帖的内容还原、编导逻辑、画面与剪辑，以及博主内容系统归纳。技术栈：React / Vite、Express、SQLite、分析 worker。详见[分析工作台](../workbenches/analysis/README.md)。

单帖流程：

```mermaid
flowchart LR
  S["来源一致性核对"] --> B["候选构建"] --> E["独立复核"]
  E -->|"有问题"| R["候选修订"]
  E -->|"无问题"| D["单帖报告"]
  R --> U["修订稿 · 保留复核状态"]
```

博主流程：

```mermaid
flowchart LR
  I["身份与登录预检"] --> L["全量作品清单"] --> S["High / Base / Low 分层"]
  S --> P["重点帖子内容还原"] --> C["博主内容系统归纳"] --> D["发布到工作台"]
```

## 图的来源

研究的阶段图与角色图摘自 token-economics 的 `docs/reports/research-shared-context/index.html`。分析图按 `packages/research/src/creator-research/service.ts` 和 `workflows/simple-review.ts` 的现有阶段绘制，去掉了旧架构图中的多博主 / Wiki 范围。创作图按当前阶段 workflow 的代码绘制；迁入时的旧创作方法图见[旧视频方法](../workbenches/creation/docs/archive/video-method.md)。

这些图说明流程，不表示各流程已经通过完整的真实运行；执行状态以各工作台的实际运行记录为准。
