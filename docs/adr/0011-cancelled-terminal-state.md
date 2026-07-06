# 11. 拍板信「中断创建」= 第十个终态 cancelled

日期：2026-07-06

## 状态

已接受

## 背景

需求生命周期原本是九态，活跃路径 Idea → … → Merged，再手动推进到
Observed/Learned。这条路径只有"往前"：拍板信（澄清 / 门禁）把人拉进来时，
人要么回答澄清、要么放行门禁，把一条需求继续往交付推。

但拍板信恰恰是人第一次认真读这条需求的时刻。如果这时人发现需求本身就立错了
（写错了、场景变了、根本不该做），九态里没有任何出口：只能硬答一个自己都不
信的澄清，或放一条注定错的 run 往前跑，再去别处收拾。这条需求还赖在
待我处理队列里，制造持续的决策噪音。

## 决定

加入第十个、也是终态的生命周期状态 `cancelled`（已中断），作为需求级的
中止出口。

- **可达性**：从任意"进行中"状态可中断——idea / spec / ready / running /
  needs_review / needs_human；从 merged / observed / learned **不可**中断。
  已交付/已沉淀的需求不能被"取消交付"，那是另一回事（回滚、下线），不属于
  这个动作。
- **终态**：cancelled 无后继，与 learned 一样是吸收态。
- **一次逻辑操作**（POST /api/raven/requirements/{id}/cancel）复用生命周期
  迁移机制走到 cancelled，并在同一个 choke point（ApplyTransition 的
  cancelled 钩子，与 Merged 注册钩子同构）连带收尾：把进行中的 run 置为
  terminated、把该需求 pending 的门禁与澄清置为 cancelled（自然离开待裁决
  队列）、把 issue 投影为 cancelled、清理对应的 inbox 项。
- **入口**：中断按钮只挂在澄清与门禁拍板信上（二者共用
  GateOrClarifyLetterCard），带一步确认；不挂在晋升信上——晋升是工作区治理，
  不是某条需求的中止。

## 后果

- 拍板信从"只能往前"变成有退路：人读懂需求后，可以整体放弃，而不是被迫喂一个
  假答案或推一条废 run。
- 待我处理队列自愈：中断即让门禁/澄清出队、inbox 出清，噪音随之消失。
- "可中断状态"这条线是刻意的边界：把"中止未交付"和"回滚已交付"分开——后者
  语义不同、代价不同，不塞进同一个按钮。
- 词表放宽落在 CHECK 约束（requirement.state、clarification.status、
  gate_review.status 各加 cancelled）；状态机真值仍在
  server/internal/raven/lifecycle.go，CHECK 只守词汇。
- run.status 的 terminated 早已存在，中断不需要为它加迁移，只是复用。
