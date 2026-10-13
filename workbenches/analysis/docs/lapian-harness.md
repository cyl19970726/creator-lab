# 拉片接入共享操作体系

此接入复用 analysis 既有拉片执行器、冻结输入、取证、Builder、Reviewer、repair 和专业报告；共享 Space 保存准确版本、Case、历史关系与评价。接入状态不表示拉片质量或速度已改善，独立产品验收另行进行。

## 本机宿主

使用 Node 24 和根 pnpm workspace。通过私有环境注入 `SELF_MEDIA_DATABASE_URL`、`SELF_MEDIA_RUNTIME_DIR`（既有原片与报告缓存）、`DOTENV_CONFIG_PATH`。禁止把凭据和报告写进代码。

```sh
pnpm build:workflow
pnpm --dir workbenches/creation exec vite build --config apps/space-workbench/web/vite.config.ts
pnpm --dir workbenches/analysis lapian:harness setup
pnpm --dir workbenches/analysis lapian:harness import EXACT_ROOT_RUN_ID '真实案例标题'
pnpm --dir workbenches/analysis lapian:harness serve
```

`setup` 显式初始化独立 Space 与私有 Agent 凭据。`serve` 不初始化、不启动模型。默认普通前端为 `http://127.0.0.1:4417/space-workbench/lapian-harness-20261014`。修改 Space/端口/私有回执目录可用 `LAPIAN_SPACE_ID`、`LAPIAN_HARNESS_PORT`、`LAPIAN_HARNESS_DIR`。第一次设置后保留同一凭据和回执目录。

历史导入显式收集最多 32 个来源运行，包括子运行、父运行和必要证据生产者。原工作区只读，原 run、step、attempt、event、artifact ID 与字节/hash 保留在目标命名空间。历史映射标记 `imported`，历史稿件的原生 artifact 身份和 Space asset version 分开；不生成新模型执行记录。重复导入核验而不覆盖；来源改变或超出上限停止。

日常操作先读项目 [lapian-workflow skill](../.agents/skills/lapian-workflow/SKILL.md)。Operator CLI 与普通前端读取相同 Space；专业原片阅读继续由 analysis 提供。该宿主不修改当前使用选择，不以 imported/候选/程序成功冒充采用或业务合格。
