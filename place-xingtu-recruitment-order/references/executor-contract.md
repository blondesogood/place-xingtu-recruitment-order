# 招募执行器合同

- 入口：`createRecruitmentSkillRuntime(...)`，内部绑定 Ego Lite 版 `createRecruitmentEgoSkillRuntime(...)`。
- 方法仅有：`prepare(text)`、`run(manifest)`、`resume({ manifest, taskSpaceId })`、`finalize({ keep })`；没有 `beginAssistance`。
- 结果：`COMPLETED`、`HUMAN_GATE_REQUIRED` 或 `BLOCKED`；输入不清楚由 `prepare` 返回 `NEEDS_CLARIFICATION`。
- schema v4 二选一：非空唯一 `orderLocators`，或 `createdAtRange + targetScope`；schema v3 日期状态继续兼容。
- 日期发现状态持久化 `initialMode/currentMode/fallbackReason/status`。单日 1–3 单为 `TABLE_FIRST`；全部、4 单及以上或跨日为 `FILTER_FIRST`。直读路径最多向筛选路径升级一次，恢复后直接从已存策略继续。
- `TABLE_FIRST` 只读当前页且不打开筛选抽屉；`FILTER_FIRST` 必须重置并应用抖音、自定义日期、待商务下单、招募四项筛选，重读生效标签后遍历分页。服务端返回的每条记录仍须由执行器按创建时间本地精确复核。
- 业务状态：`ORDER_LOCKED → DRAFT_READY → PUBLISH_INTENT → TASK_VERIFIED → WRITEBACK_READY → CONFIRM_INTENT → FINAL_OBSERVED → DONE`。
- 预算不足由任务总预算减预计总费用判定；每个活动每批最多追加一次 ¥10,000，追加后必须重读总预算，结果未知只查询、不重复追加。
- 批次首次进入须锁定 `candidateVersion + runtimeFingerprint`。无状态性派发的旧状态可在重新只读预检后绑定当前版本；已有派发而缺少绑定，或摘要变化，返回 `RUNTIME_VERSION_MISMATCH` 并阻止新写入。
- 正式执行只接受 macOS Ego Lite facade。`run` 调用 `useOrCreateTaskSpace`；登录/验证码/安全验证调用 `handOffTaskSpace`；只有用户明确继续后 `resume` 才调用 `takeOverTaskSpace`。
- `completeTaskSpace(..., { keep })` 只能在终态报告完成后由独立 `finalize` 调用，并核对返回结果。
- 所有页面操作统一经过 Ego 适配器。每次操作前持久化批次/订单、业务阶段、操作、页面角色、输入摘要、层级、次数、写入状态和耗时；不保存 DOM、截图、URL、Cookie、令牌、凭据或坐标。
- 非状态性动作最多 `EGO_SEMANTIC` 一次、`EGO_VISUAL` 一次。状态性动作统一为“持久化意图 → `beforeDispatch` → 单次点击 → 新鲜结果查询”，视觉层也不得重试点击。
- 普通导航、输入回显、Tab 切换和非关键页面不连续稳定复读。只有提交前、任务生成后、内部确认后三节点，预算特例和明确加载状态允许等待；提交后任务查询最长 90 秒。
- 旧 Chrome tier 只允许被状态存储读取以迁移；新的运行记录和候选包只能产生 `EGO_SEMANTIC`、`EGO_VISUAL` 或 `HUMAN`。
- 正常路径只在提交前做一次轻机器复核。运行结果从 ActiveOperationRecord 汇总各操作耗时；用户等待、安全验证和平台长加载单独标注。
