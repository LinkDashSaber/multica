# trigger.dev 自托管作为 workflow 执行基座

Workflow 引擎最重的基建是持久执行：长任务续跑、重试、队列、人工等待点、观测。决定：不自研，用 trigger.dev（Apache 2.0）自托管承载 workflow 脚本；workflow 即 TypeScript task，人工门禁用 waitpoint，`agent()` 调用翻译为对 multica 的派单。workflow 采用 git-backed 部署（脚本存 git 仓库，改动走 commit + review + CI deploy）而非运行时解释——慢约 1-2 分钟生效，换来 workflow 变更天然具备版本化、审批与审计。

已知限制：自托管无 Checkpoints（云端独占），暂停在门禁上的 run 会占住一个 runner 容器。内部并发量级下可接受（runner 用 micro 机型）；若规模上来，改为在人工门禁处切段、审批事件触发续跑。
