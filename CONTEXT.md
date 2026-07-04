# Raven — 企业级智能研发执行平台

以需求表达为起点，把需求转化为可执行、可追踪、可审计的交付过程，由外部 coding agent 在受控 workflow 中完成闭环。本文件是唯一术语表：讨论与代码都用这里的词。

## Language

### 编排

**Workflow（交付策略）**:
某一类需求的可执行交付策略，以脚本形式编写，版本化、可沉淀、可度量。平台的一等资产。
_Avoid_: 流程模板、pipeline（那是 CI 的词）

**合同（Contract）**:
Workflow 的静态声明部分：阶段列表、门禁位置、权限边界、预算上限。人审批的是合同，机器执行的是脚本。
_Avoid_: meta、配置

**节点（Node）**:
Workflow 中的一个执行单元，声明所用 agent、模型、思考等级、skill 与职责 prompt。
_Avoid_: 自动化、step

**Squad**:
探索型节点：lead agent 现场拆解并指挥小队。用于无既定 workflow 的需求，其执行轨迹是新 workflow 的孵化原料。
_Avoid_: 小队（口语可用，文档统一 Squad）、agent team

### 生命周期

**需求（Requirement）**:
用户提出的一次交付意图，生命周期状态机的根对象。一个需求可产生多个 PR，也可以不产生代码。
_Avoid_: issue（指 multica 中的投影对象）、任务（指 agent 的一次执行）

**生命周期（Lifecycle）**:
需求的九个状态：Idea → Spec → Ready → Running → Needs Review → Needs Human → Merged/Shipped → Observed → Learned。闭环指走到 Learned，不是 Merged。

**门禁（Gate）**:
流程中的检查点，凭证据自动通过或挂起等人裁决。升级给人是一等节点类型。
_Avoid_: 卡点、审批节点

**拍板点（Decision Point）**:
run 挂起等人的统一概念，门禁裁决与澄清问答都是它的实例。三要素：停在流程的哪个节点、拍板所需上下文、响应形式（通过/驳回、自由回答、单选推荐项）。收件箱拍板信、"待我处理"队列、画布高亮节点只认这一个概念；仅 Raven 拍板点使用拍板信版式，multica 原生通知不变。
_Avoid_: 待办、审批任务

**证据（Evidence）**:
阶段产出的结构化事实（diff、测试结果、CI 状态、截图）。"完成"的唯一凭据；文本声明不是证据。

**审查包（Review Package）**:
门禁处呈现给人的证据集合，按消费者（研发/QA/管理）组织。

### 治理与沉淀

**信任额度（Trust Level）**:
在 workflow × 项目维度上由运行记录累积的自治等级，决定门禁从事前确认降级为事后抽查的资格。晋升不自动生效：同一门禁连续 8 次人审零驳回后，workflow 经拍板点向人申请降级（抽查 1/5）；抽查失手立即回全审，驳回清零计数。

**生产线（Production Line）**:
挣足信任额度、门禁已降级的 workflow。对管理层叙事用词。

**沉淀（Compounding Assets）**:
组织能力的三类载体：workflow（怎么组织交付）、skill（怎么做某件事）、事实与口径（业务世界模型）。三档门槛：事实逐条、skill 单次交付可提议、workflow 须同构重复 N 次。

**沉淀阶段（Learned Stage）**:
生命周期的收尾阶段：需求走到 Learned 才算真正关闭。零成本归档轨迹特征与同构计数；agent 深挖仅由信号触发（计数达标 / 门禁驳回或返工 / 执行自报 / 用户手动）。

**执行自报（Learning）**:
执行中的 agent 经 `ctx.learning()` 随手记录的沉淀候选心得，带出处（哪次 run 哪个节点）。沉淀管道的主进料口；事后深挖是补充。
_Avoid_: 笔记、memo

### 架构

**控制面（Control Plane）**:
Raven 本体：持有需求生命周期、workflow 注册、证据链与审计的服务。不执行 agent。

**执行层（Execution Layer）**:
控制面驱动的基础设施：multica（派单/看板/runtime）、trigger.dev（持久运行）、CLI agent（Claude Code、Codex 等）。外部系统状态只作为证据被采集，不反向驱动控制面。
