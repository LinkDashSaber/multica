# Workflow 作者只能使用 Raven SDK 的受控原语

Workflow 直接裸写 trigger.dev task 会让合同、门禁、证据全部依赖作者自觉，审计完整性无法保证。决定：作者面对的是 Raven SDK——`defineWorkflow({contract}, script)`，合同（阶段/门禁/预算/权限）是必填静态声明，脚本内只能使用受控原语：`agent()`（自动走 multica 派单并采证）、`gate()`（自动挂起等审批并记录裁决）、`evidence()`、`squad()`。治理落在类型系统和原语实现里，作者写不出绕过门禁的 workflow。曾考虑裸 trigger.dev + 规范文档，因治理不可保证而放弃；声明式 YAML 因表达力不足（无循环/条件/动态扇出）而放弃。

Workflow 的三条产生路径殊途同归：人手写、Squad 运行轨迹提炼、自然语言描述由 agent 生成草稿——最终都以 SDK 形态提交，经人审后注册生效（git-backed，见 ADR-0002）。
