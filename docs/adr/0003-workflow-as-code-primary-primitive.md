# workflow-as-code 是首要编排原语，Squad 降格为节点类型

复杂任务编排有两条路：lead agent 现场拆解（multica Squad、Claude Code agent team）或确定性脚本编排（Claude Code Workflow）。决定：以 workflow-as-code 为脊椎——控制流是代码，智能只存在于节点内部。理由：企业治理的四个核心主张（可审计、可沉淀、可度量、信任分级）全部依赖确定性结构；模型驱动的控制流不可复现、不可保证完备性、好的拆解随 run 蒸发。

Squad 不废弃，收编为两个部件：探索型节点（拆解方式事先不可知的阶段，如事故排查）；新 workflow 的孵化器（无既定 workflow 的需求先走通用 Squad，平台记录 lead 实际轨迹，提炼为 workflow 草稿）。配套补偿 workflow 的僵化短板：升级给人是一等节点，需求分类置信度低时 fallback 到通用 Squad。
