# 技术栈跟随宿主：server 侧 Go，workflow 侧 TypeScript

单仓库决策（ADR-0001）后，Raven 代码直接生长在 multica monorepo 内，技术栈跟随宿主：状态机、证据、审计等 server 能力用 Go 写进 multica server（新模块+新迁移）；审查包等 UI 用 TS/Next.js 写进 apps/web（新页面）；workflow 层（Raven SDK + workflow 定义）是 fork workspace 内的新 TS 包，对接 trigger.dev SDK。Go/TS 之间的合同与证据类型经 JSON Schema 共享。

取代先前的"TypeScript 全栈独立 monorepo"决策——该方案随旁挂架构一起废弃：复用 multica 的认证、布局、组件、迁移体系与开发工具链（make dev 一键起全套），比另起一套 TS 全栈更快见到第一版功能；双语言成本由宿主仓库既有的 Go+TS 混合工具链吸收。
