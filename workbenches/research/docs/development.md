# 开发、数据与运维

## 配置

| 变量 | 默认值 | 内容 |
| --- | --- | --- |
| `WORKBENCH_CONTENT_ROOT` | `.local/content` | `manifest.json` 与不可变来源文件 |
| `WORKBENCH_STATE_ROOT` | `.local/state` | `research.sqlite`、`collaboration.sqlite`、private-traces |
| `WORKBENCH_ARTIFACT_ROOT` | `.local/artifacts` | 研究正文版本 |
| `WORKBENCH_MEDIA_ROOT` | 未设置 | 未来媒体适配器的显式输入，首版暂不消费 |
| `PORT` | 4327 | 仅绑定 127.0.0.1 |

路径相对项目根解析，公共 API 不暴露绝对路径或模型 trace。当前来源目录采用新工作台自己的 manifest 与哈希文件。旧报告一次性导入工具已移除，不再维护旧目录或旧报告格式兼容；已导入的来源字节和新工作台运行记录保留。原生来源录入与目录写入仍待实现，详见 storage.md。

备份前停止 API 与 worker，复制整个三个数据根（包括 SQLite 的 WAL/SHM 如仍存在）到独立备份目录。不要只复制一份运行中的主 SQLite 文件。恢复时同时恢复对应来源、状态、产物，再按 manifest 校验。不同实例使用不同 stateRoot，不能共享单个 worker 数据库跨主机运行。

## 检查

`pnpm check` 构建固定上游包和前端，运行 TypeScript 检查及 node:test。测试包含独立句柄入队/领取/取消/恢复、命令幂等、精确修订关系、冻结原生 Skill 包加载、来源防篡改、用户事件范围和前端增量合并。测试产物与用户数据分开。

真实研究会消耗模型额度，通过正常 API 启动并留下真实账本。不得把 mock 的报告或评论写入用户账本后声称真实成功。人工接受必须由用户在所选版本及范围上明确操作。

If the machine default is a different Node major, use an existing Node 24 installation or run `npx --yes --package=node@24 --package=pnpm@10.28.2 -c "pnpm api"` (and separately `pnpm worker` through the same wrapper). This uses the package cache, not a global Skill or system Node replacement.
