# Raven 在 multica fork 内直接生长（单仓库）

我们需要看板、agent 派单、多 CLI runtime 适配、skill 沉淀等平台基础能力，multica（修改版 Apache 2.0，单组织内部使用免费）已实现其中 80%。最终决定：fork multica（LinkDashSaber/multica）作为**唯一开发仓库**，Raven 的全部能力（九状态生命周期、证据链、审查包 UI、workflow 层）直接在 fork 内以新模块/新页面/新表的形式生长；上游更新通过 `git merge upstream/main` 尽力接收，冲突由 agent 解决，允许最终永久分叉。

演进过程记录：最初决策为"旁挂不 fork"（独立控制面服务经 API 驱动 multica），后放宽为"浅 fork + 最小 patch 集"，最终放弃分离——因为旁挂要求先建独立服务、独立库、独立 UI 外壳、API 桥接与状态投影同步整整一层基础设施，对两人团队的 v1 是纯负担；且"这是我们的仓库，直接改"对多人协作的认知负担最小。

不变的边界（从仓库边界降级为模块边界）：Raven 领域逻辑（生命周期/证据/workflow）住在自己的模块和目录里，与 multica 原有执行层代码（派单/看板/runtime）清晰分区，为将来可能的拆分保留路径。工程纪律两条：数据库迁移用独立高位编号段（900+）避免与上游撞号；少碰共享文件（路由注册表、侧边栏、lockfile）以降低合并冲突。按许可证，apps/web 的 logo 与版权信息必须保留。若将来平台对外商业化，multica 许可证要求商业授权——该前提变化时本决策需重审。
