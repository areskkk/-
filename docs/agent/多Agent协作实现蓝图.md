# 一、目标态：你最终要达到的系统长什么样

你最终不是要“某个节点会调工具”，而是要一个 **企业级多 Agent 协作 runtime** ：

```text
用户请求 / 业务事件
    ↓
Coordinator Agent（任务拆解 / 规划 / 汇总）
    ├─ Retriever Agent（政策检索 / RAG）
    ├─ DocumentVision Agent（OCR / 材料理解）
    ├─ Eligibility Agent（规则计算 / 证据整理）
    ├─ RiskJudge Agent（风险裁决 / 置信度判断）
    └─ ReviewDrafter Agent（审核意见草稿）
    ↓
Verifier / Aggregator（结果校验 / 冲突裁决）
    ↓
Final / Human Gate / Fallback
```

它必须同时满足三件事：

* **能自主** ：自己决定下一步做什么
* **能协作** ：多个 agent 有明确分工、输入输出协议
* **能生产** ：权限、预算、审计、回放、人工接管都完整

---

# 二、基于你当前项目，哪些是“已有底座”

你现在已经有这些非常关键的基础：

## 1. Agent runtime 的骨架

已有目录：

* [src/modules/agents/runtime/](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/)
* [src/modules/agents/tools/](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/tools/)
* [src/modules/llm/](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/llm/)

## 2. 工具底座

已有：

* [tool.types.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/tools/tool.types.ts)
* [tool-registry.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/tools/tool-registry.ts)
* [tool-runner.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/tools/tool-runner.ts)

说明：

* 工具注册
* 输入校验
* 权限/allowed agent
* 调用上限
* failed tool call 落库
* 错误分类

这些已经是 **全局自主 runtime 的地基** 。

## 3. 已工具化的业务能力

已有工具：

* `rag.search`
* `ocr.material_evidence.read`
* `eligibility.rule_engine.check`

## 4. 局部原生 tool loop

已有：

* [agent-tool-loop.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/agent-tool-loop.ts)
* [consultation-graph-runner.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/consultation-graph-runner.ts)

说明 consultation 的 retrieval_planner 已经具备：

* LLM 发 `tool_call`
* tool result 回灌
* final JSON 收口
* policy scope 强注入
* fallback 防重复

这说明你已经完成了：

> **“单节点局部自治”**

下一步不是重写一切，而是把这套能力 **提升为全局 runtime** 。

---

# 三、你应该采用的多 Agent 角色设计

这里非常关键。

不要先想着“并发”，先把**角色边界**设计对。

---

## A. Coordinator Agent

### 职责

* 读取任务
* 决定需要哪些子任务
* 按顺序或并发调用子代理
* 汇总结果
* 决定是结束、继续、还是转人工

### 不应该做

* 不直接做 OCR 细节
* 不直接做规则计算细节
* 不直接做高风险写操作

### 允许工具

* 只允许 orchestration 级动作
* 例如：`delegate_subagent`、`request_human`、`finish_run`
* 最多只读工具少量辅助

---

## B. Retriever Agent

### 职责

* 负责政策检索
* 负责 RAG query 重写
* 负责 citation 质量判断
* 可以多轮检索

### 允许工具

* `rag.search`

### 输出

统一返回：

* `citations`
* `confidence`
* `coverage_note`
* `needs_more_search`

---

## C. DocumentVision Agent

### 职责

* 负责材料摘要
* OCR 结构化理解
* 标记低置信字段
* 输出“可硬证据 / 不可硬证据”判断基础

### 允许工具

* `ocr.material_evidence.read`

### 输出

统一返回：

* `materials_summary`
* `low_confidence_material_ids`
* `hard_evidence_allowed`
* `missing_material_signals`

---

## D. Eligibility Agent

### 职责

* 调规则引擎
* 解释规则结果
* 输出已满足 / 未满足 / 缺字段

### 允许工具

* `eligibility.rule_engine.check`

### 输出

统一返回：

* `result`
* `matched_conditions`
* `failed_conditions`
* `missing_fields`
* `rule_summary`

---

## E. RiskJudge Agent

### 职责

* 不直接查原始事实
* 只消费 Retriever / Eligibility / DocumentVision 的结果
* 判断置信度是否够
* 判断是否需要人工兜底

### 允许工具

* 默认 **无工具** ，只做裁判
* 后续最多允许只读 cross-check 工具

### 输出

统一返回：

* `approved`
* `should_fallback`
* `risk_reasons`
* `confidence`

---

## F. ReviewDrafter Agent

### 职责

* 基于前面各 agent 的结果生成审核草稿
* 不能直接自动 adopt/reject
* 只能出草稿

### 允许工具

* 默认无工具，或只读上下文工具

### 输出

统一返回：

* `draft_decision`
* `draft_comment`
* `requires_human_confirmation`

---

# 四、你应该怎么设计“统一全局 runtime”

这是从“局部 tool call”升级到“全局自主 Agent loop”的核心。

---

## 1. 从“node 调 LLM”改成“runtime 执行动作”

你现在更像：

```text
graph node -> callJsonAgent -> 可能调用 tool -> 返回 JSON -> 下一个 node
```

你未来要变成：

```text
while run not finished:
  runtime 读当前 state
  当前 agent 输出 action
  runtime 执行动作
  写回 state / step / audit
  判断是否结束 / 是否转人工 / 是否继续
```

---

## 2. 定义统一 action schema

不要只有 tool call。

建议你统一成 action 层。

---

### 最小 action 集

建议第一版就支持这 6 类：

#### 1）`call_tool`

调用工具

#### 2）`delegate_subagent`

委派给某个子代理

#### 3）`respond_final`

输出最终结果

#### 4）`request_human`

请求人工介入

#### 5）`update_plan`

更新任务计划 / 当前阶段说明

#### 6）`stop_run`

终止运行（失败 / 超预算 / 不可继续）

---

## 3. runtime 的主循环职责

统一 runtime 要负责：

* 读取当前 phase/state
* 选择当前 active agent
* 把 allowed actions / allowed tools 注入 prompt
* 解析 agent action
* 执行动作
* 写 step / tool_call / llm_call 审计
* 判断 budget / max rounds / timeout
* 判断是否需要 fallback / interrupt

---

## 4. graph 的职责降级

你现有 graph 不要一刀切删掉。

建议把 graph 从“主流程控制器”降级成：

### Phase Guard / Policy Guard

例如：

* consultation phase 允许：
  * retriever
  * risk judge
  * final
* application phase 允许：
  * document_vision
  * eligibility
  * risk judge
* review phase 允许：
  * document_vision
  * drafter
  * request_human

也就是说 graph 不再规定：
`A -> B -> C`

而是只规定：

> 当前 phase 允许哪些 agent / action / tool

---

# 五、统一数据结构设计

这部分很重要。后面多 Agent 协作失败，大多是因为没有稳定的共享结构。

---

## 1. Run State 要拆成 5 层

建议在 [agents.types.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/agents.types.ts) 里逐步演进出这种结构：

---

### A. `input`

原始业务输入

例如：

* `question`
* `application_id`
* `item_id`
* `policy_id`

---

### B. `runtime`

运行时控制信息

例如：

* `entrypoint`
* `phase`
* `active_agent`
* `budget`
* `max_turns`
* `turn_count`
* `actor`
* `worker_id`
* `job_id`

---

### C. `plan`

当前 agent 任务计划

例如：

* `goal`
* `open_tasks`
* `completed_tasks`
* `current_hypothesis`

---

### D. `artifacts`

各子代理产出的结构化结果

例如：

* `retrieval`
* `ocr`
* `eligibility`
* `risk`
* `review_draft`

注意：

这里应该成为 **多 agent 协作的共享结果层** 。

---

### E. `control`

控制与中断信息

例如：

* `fallback`
* `manual_resume`
* `approval_requests`
* `interrupt_reason`
* `termination_reason`

---

## 2. Subagent Result Contract

每个子代理都必须有稳定输出 schema。

例如：

### RetrieverResult

* `citations`
* `confidence`
* `policy_scope_respected`
* `needs_more_search`

### OcrResult

* `materials`
* `low_confidence_material_ids`
* `hard_evidence_notice`

### EligibilityResult

* `result`
* `matched_conditions`
* `failed_conditions`
* `missing_fields`

### RiskResult

* `approved`
* `should_fallback`
* `reasons`
* `confidence`

---

## 3. 不要让子代理直接写最终业务结论

统一原则：

* **子代理产“结构化中间结果”**
* **Coordinator / Verifier 再决定最后结论**

这样能避免多 Agent 互相覆盖业务状态。

---

# 六、工程模块蓝图

下面按“应该新增/重构哪些模块”来列。

---

## 模块 1：Agent Action Schema

### 建议新增

* [src/modules/agents/runtime/agent-action-schema.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/)

### 作用

定义并验证 agent 输出动作：

* call_tool
* delegate_subagent
* request_human
* respond_final
* stop_run
* update_plan

---

## 模块 2：Global Agent Runtime Loop

### 建议新增

* [src/modules/agents/runtime/agent-runtime-loop.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/)
* 或在现有 [agent-tool-loop.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/agent-tool-loop.ts) 之上升级

### 作用

统一处理：

* one turn -> one action
* tool execution
* subagent delegation
* budget / max rounds
* stop conditions
* fallback
* failure step

---

## 模块 3：Subagent Registry

### 建议新增

* [src/modules/agents/runtime/subagent-registry.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/)
* [src/modules/agents/runtime/subagent-definitions.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/)

### 作用

定义：

* agent 名称
* 角色
* 可用工具
* 输入 schema
* 输出 schema
* phase 限制
* 默认预算

---

## 模块 4：Phase Policy / Orchestration Guard

### 建议新增

* [src/modules/agents/runtime/phase-policy.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/)

### 作用

定义每个业务 phase 下允许：

* 哪些 agent
* 哪些 tools
* 哪些 actions
* 哪些 side effects 需要人工审批

---

## 模块 5：Result Aggregator / Verifier

### 建议新增

* [src/modules/agents/runtime/result-aggregator.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/)
* [src/modules/agents/runtime/result-verifier.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/)

### 作用

负责：

* 合并子代理结果
* 检查冲突
* 判断是否需要再召回某个 agent
* 判断是否达到 final 条件

---

## 模块 6：Approval / Human Gate

### 建议新增

* [src/modules/agents/runtime/approval-gate.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/)

### 作用

统一处理：

* 哪些动作必须人工确认
* 生成 approval request
* 人工回复后如何 resume

---

# 七、分阶段实施路线（P0 ～ P5）

---

# P0：当前底座收口

> 你现在基本已经在这一步末尾

## 目标

让现有：

* Tool Runner
* consultation 原生 tool call
* scope / fallback / 权限 成为稳定底座

## 当前状态

基本完成。

## 剩余建议

* step 聚合 token usage
* max rounds 失败 step 记录
* invalid_input 审计脱敏

---

# P1：统一单 Agent runtime loop（只落 consultation）

> 这是你下一步最该做的

## 目标

把 consultation 从：

* graph 主导 + retrieval_planner 局部 tool loop

升级成：

* 单 Agent runtime loop 主导
* graph 只做 phase guard

## 交付

* `agent-action-schema.ts`
* `agent-runtime-loop.ts`
* `phase-policy.ts`
* consultation 改成 runtime 驱动

## 不做

* 不扩 application/review
* 不做多 agent
* 不做高风险 side effect 自动化

## 验收

* consultation 能自己选择：
  * call_tool
  * continue
  * request_human
  * final
* 不是死写 retrieval -> analysis -> judge
* 测试能覆盖 max rounds / budget / fallback

---

# P2：application 接入统一 runtime

## 目标

让 application 链路进入统一 runtime，而不是固定 graph 强编排。

## 交付

* `document_vision` 子任务动作化
* `eligibility` 子任务动作化
* fallback / manual resume 进入统一控制

## 验收

* application 主要闭环可由 runtime 决策推进
* OCR / eligibility 仍保持现有权限边界
* side effect 仍然只允许安全范围

---

# P3：review 半自主化

## 目标

review 进入“半自主化”：

* 可以生成草稿
* 可以多轮判断
* 但不能自动 adopt / reject

## 交付

* ReviewDrafter Agent
* RiskJudge Agent 在 review phase 接入
* 审核草稿由 runtime 生成

## 验收

* 审核草稿链路不再依赖固定 node 顺序
* adopt/reject 仍必须人工操作
* OCR summary 不泄露 fields

---

# P4：多 Agent 协作

## 目标

引入 coordinator + worker 协作。

## 第一版建议只做 3 个 agent

* Coordinator
* Retriever
* Verifier

然后再加：

* DocumentVision
* Eligibility
* ReviewDrafter

## 交付

* subagent registry
* delegate_subagent action
* 子代理输入输出 schema
* result aggregator

## 验收

* coordinator 能委派 retriever
* verifier 能校验结果是否够
* fan-out/fan-in 有统一记录
* budget / permission / scope 独立控制

---

# P5：企业级生产化

## 目标

从“能跑”升级到“能长期运营”

## 交付

* run replay
* 统一 cost/tokens dashboard
* provider/tool 熔断
* approval gate
* kill switch
* side-effect 分类
* 运维控制能力

## 验收

* 任意失败 run 可回放
* 任意人工接管可 resume
* 预算超限可控
* 高风险动作有审批和审计

---

# 八、每阶段建议改哪些文件

---

## P1 重点文件

### 新增

* [src/modules/agents/runtime/agent-action-schema.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/)
* [src/modules/agents/runtime/agent-runtime-loop.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/)
* [src/modules/agents/runtime/phase-policy.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/)

### 改造

* [src/modules/agents/runtime/consultation-graph-runner.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/consultation-graph-runner.ts)
* [src/modules/agents/runtime/agent-tool-loop.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/agent-tool-loop.ts)
* [src/modules/agents/agents.types.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/agents.types.ts)
* [src/modules/agents/runtime/step-recorder.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/step-recorder.ts)

### 新增测试

* `test/agent-runtime-loop.test.ts`
* `test/batch18.runtime-loop.integration.test.ts`

---

## P2 重点文件

### 改造

* [src/modules/agents/runtime/application-graph-runner.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/application-graph-runner.ts)
* [src/modules/agents/tools/material-read.tool.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/tools/material-read.tool.ts)
* [src/modules/agents/tools/eligibility.tool.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/tools/eligibility.tool.ts)

### 新增测试

* `test/batch19.runtime-loop.integration.test.ts`
* `test/application-agent-runtime-controls.test.ts`

---

## P3 重点文件

### 改造

* [src/modules/agents/runtime/review-graph-runner.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/review-graph-runner.ts)
* [src/modules/review/review.service.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/review/review.service.ts)

### 新增

* `review-drafter` 相关 runtime 定义
* `approval-gate.ts`

### 新增测试

* `test/batch20.review-runtime.integration.test.ts`

---

## P4 重点文件

### 新增

* [src/modules/agents/runtime/subagent-registry.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/)
* [src/modules/agents/runtime/result-aggregator.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/)
* [src/modules/agents/runtime/result-verifier.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/)

### 新增测试

* `test/multi-agent-coordinator.test.ts`
* `test/multi-agent-fanout.integration.test.ts`

---

## P5 重点文件

### 改造

* [src/modules/agents/agents.repository.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/agents.repository.ts)
* [src/modules/agents/agents.service.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/agents.service.ts)
* [src/modules/agents/runtime/agent-run-worker.ts](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/agent-run-worker.ts)

### 新增

* run replay / ops 工具 / 管理接口

---

# 九、每阶段测试门禁

你后面每一阶段都要带测试目标，不然很容易变成“看起来更智能，实际上更脆”。

---

## P1 测试门禁

* 工具循环最多轮数
* action schema 非法拒绝
* consultation 可 request_human / final / call_tool
* step token usage 聚合正确
* fallback 幂等

---

## P2 测试门禁

* application phase 下不能越权读别的 application
* OCR 低置信度不能变成硬证据
* eligibility fallback 可 resume
* tool scope 不能被模型覆盖

---

## P3 测试门禁

* reviewer 可生成草稿
* reviewer 不能自动 adopt/reject
* 审批动作必须走人工 gate
* review summary 不泄露 fields

---

## P4 测试门禁

* coordinator 能委派子代理
* 子代理输出不合格时 verifier 拒收
* fan-out 并发时预算不失控
* 子代理不能越权调全量工具

---

## P5 测试门禁

* 任意失败 run 可 replay
* 任意人工中断可恢复
* provider 熔断可降级
* 超预算必停
* side-effect 工具审批完整落审计

---

# 十、给 Codex 的任务模板

下面这些模板你后面可以直接用。

---

## 模板 1：做 P1

> 当前基线：缺口 1/2 已完成，Tool Runner 与 consultation 原生 rag.search tool call 已稳定。
>
> 当前目标：实现统一单 Agent runtime loop，仅落在 consultation 域；让 Agent 决定下一步 action，而不是固定 graph 决定 retrieval/planner/judge 顺序。
>
> 当前边界：不扩 application/review，不做多 Agent，不放开高风险 side-effect。
>
> 当前输出要求：先给 implementation plan（模块、状态结构、测试门禁），再改代码。

---

## 模板 2：做 P2

> 当前基线：consultation 已切到统一单 Agent runtime loop。
>
> 当前目标：把 application 链路接入统一 runtime，支持 document_vision / eligibility / fallback 统一动作化。
>
> 当前边界：不改 review，不做多 Agent，不做自动审批。
>
> 当前输出要求：先给修改文件列表、状态流和回归测试清单，再实现。

---

## 模板 3：做 P4

> 当前基线：consultation/application/review 已接入统一单 Agent runtime。
>
> 当前目标：增加最小多 Agent 协作闭环：Coordinator + Retriever + Verifier。
>
> 当前边界：不做全业务域 fan-out，不做任意 agent 自由互调，只允许 coordinator 委派指定子代理。
>
> 当前输出要求：先给 subagent schema、权限边界、聚合逻辑、失败场景，再实现。

---

# 十一、基于当前代码的落地现状补充

上面的蓝图偏“目标态/路线图”，但结合你仓库当前实现，建议再明确补上下面这些**已经落地的真实能力与仍然存在的边界**，避免后续判断阶段时高估或低估现状。

---

## 1. 当前已经不是“graph 主导”，而是“runtime 主导，graph 退为入口适配层”

你现在的 consultation / application / review 三条链路，实际上都已经把主流程控制权收敛到了统一 runtime：

* `consultation-graph-runner.ts` 已直接转发到 `agentRuntimeLoop.runConsultation(...)`
* `application-graph-runner.ts` 已直接转发到 `agentRuntimeLoop.runApplication(...)`
* `review-graph-runner.ts` 已直接转发到 `agentRuntimeLoop.runReview(...)`

这意味着当前真实架构更接近：

```text
AgentRunService
  -> dispatchRun
    -> phase graph runner（轻入口）
      -> AgentRuntimeLoop（主循环）
        -> action / tool / subagent / fallback / final
```

也就是说，P1 在工程上其实已经基本落地，后面重点不是“是否进入 runtime 主导”，而是**如何把当前 runtime 主导继续扩成更通用的多 Agent runtime**。

---

## 2. 当前多 Agent 协作已经落地，但属于“受限委派型”，不是开放式自治网络

你现在不是完全没有多 Agent，而是已经有了一个**受 phase 约束的最小多 Agent 闭环**：

* coordinator：
  * consultation -> `supervisor`
  * application -> `application_assist`
  * review -> `review`
* worker / verifier：
  * consultation -> `retrieval_planner`、`policy_analysis`、`risk_judge`
  * application/review -> `document_vision`、`math_verification`、`risk_judge`

并且已经具备：

* `delegate_subagent`
* 子代理白名单
* phase 级 agent 限制
* 子代理 permission scope 绑定
* 子代理 output contract 校验
* verifier 聚合写回 runtime state

这说明你现在的真实状态不是“还没开始做 P4”，而是：

> **P4 的最小闭环已经做出第一版，但仍然是受控委派，不是自由协作。**

---

## 3. 当前 fan-out/fan-in 是“顺序 fan-out + verifier 汇总”，不是并发 fan-out

这个点建议在蓝图里明确写清楚。

当前 `delegate_subagent` 虽然已经能一次委派多个子代理，但执行方式仍然是：

* coordinator 发起委派
* runtime 逐个执行子代理
* 最后由 `risk_judge` 作为 verifier 汇总
* 聚合结果写入 `runtime.coordinator / runtime.subagents / runtime.verifier`

也就是说当前是：

```text
delegate_subagent
  -> subagent A
  -> subagent B
  -> subagent C
  -> verifier
  -> aggregate state
```

而不是：

```text
parallel fan-out
  -> subagent A || B || C
  -> fan-in merger
  -> verifier
```

所以后续如果要继续演进，真正新增的能力应该是：

* 并发 fan-out
* 子代理独立预算隔离
* 并发结果冲突仲裁
* 并发失败重试与局部降级

而不是再泛泛地说“支持多 Agent”。

---

## 4. 当前子代理大多还是“受控推理步骤”，还不是“嵌套自治 runtime”

蓝图里的理想态，容易让人理解成每个子代理都可以像主 agent 一样独立多轮思考、独立行动、独立 tool loop。

但结合当前实现，实际情况更准确地说是：

* `retrieval_planner` 当前更像 retrieval query planner
* `policy_analysis`、`document_vision`、`math_verification`、`risk_judge` 当前更像受控的结构化推理节点
* 它们多数是一次 `callJsonAgent(...)` 收口
* 不是每个子代理都再跑一个自己的 runtime action loop

因此建议在蓝图里把这层边界写清楚：

> 当前多 Agent 属于“runtime 内部子任务代理化”，还不是“可递归嵌套的自治子 runtime”。

这会直接决定后续 P4/P5 的设计复杂度。

---

## 5. 当前已经有很强的生产级控制，这部分蓝图写得偏少

你现在代码里最容易被低估的，不是 agent 能力，而是**生产治理能力**。建议把这一块单独补进蓝图。

### 5.1 Worker lease / heartbeat / stale worker 防副作用

当前 run 执行不是简单地“拿起来跑”，而是有：

* worker lease
* heartbeat
* lease 丢失后拒绝继续写状态
* step / checkpoint / fallback attach 都受 lease 约束

这点非常关键，因为多 Agent runtime 一旦没有 lease 一致性保护，就很容易出现：

* 旧 worker 和新 worker 同时写 checkpoint
* fallback 重复创建
* step 顺序错乱
* run 状态被过期执行覆盖

所以建议把这一点明确列为：

> **企业级多 Agent runtime 的一致性底座：lease + checkpoint + 审计写入保护**

### 5.2 预算控制不是简单计数，而是“预留 + 结算”

当前预算控制已经不只是：

* 限制 max tokens
* 限制 max cost

而是更接近生产级策略：

* 启动 run 前做预算校验
* LLM 调用前预留当日成本额度
* 调用完成后按实际 usage 结算
* 超预算会被阻断并审计

建议把它写成独立机制，而不是只在 P5 里一句带过。

### 5.3 模型健康治理：熔断 + fallback model

当前蓝图写了 provider/tool 熔断，但建议明确补充到“模型层”而不只是“工具层”：

* rate limit 触发模型级 circuit breaker
* 熔断打开后本地阻断后续请求
* 必要时切换 fallback model

这对于多 Agent 尤其重要，因为多 Agent 会把单点模型故障放大成全链路不稳定。

### 5.4 安全边界：不可信内容包装 + 脱敏审计

当前代码已经有：

* `wrapUntrustedContent(...)`
* prompt 前内容脱敏
* audit detail 脱敏

建议蓝图明确加一条原则：

> **所有用户输入、OCR 摘要、RAG 结果、人工恢复 payload 都必须视为不可信内容进入 prompt。**

否则后面多 Agent 越多，prompt 注入面只会更大。

---

## 6. review 域实际上已经有“安全包络”，建议在蓝图中明确写出

review 现在不只是“提示词里说不能自动审批”，而是已经有三层约束：

* prompt 约束：禁止 approve / reject / adopt
* runtime 约束：`respond_final` 只生成草稿
* 持久化约束：最终落 `review_agent_draft`，并显式标记 `no_auto_decision`

这一点说明 review phase 已经形成比较清晰的安全边界：

> **review agent 可以生成意见草稿，但不能直接落业务决策。**

建议把这条写成蓝图中的显式生产规则，而不是只当作当前实现细节。

---

## 7. 当前状态结构已经开始具备“共享 artifact 层”雏形

虽然蓝图里建议把 Run State 拆成 input / runtime / plan / artifacts / control 五层，但你当前实际 state 已经在往这个方向靠了：

* `input`：已有
* `runtime`：已有，而且包含 actor / worker / budget / coordinator / subagents / verifier
* `plan`：已有初步入口，`update_plan` 会写 `current_hypothesis / open_tasks / completed_tasks`
* `artifacts`：虽然尚未统一命名为 `artifacts`，但实际上已有
  * `retrieval`
  * `policy_analysis`
  * `ocr`
  * `document_vision`
  * `eligibility`
  * `math_verification`
  * `judge`
  * `review_draft`
* `control`：当前分散在 `fallback / final / errors / manual_resume` 等字段

因此，后续状态结构演进的重点，不是从零设计，而是：

* 统一 artifact 命名层
* 统一 control 层
* 收拢散落字段
* 明确 resume / interrupt / approval 的稳定 contract

---

## 8. 建议新增一个“当前已完成 / 当前未完成 / 终态增强项”的现实清单

为了让蓝图更贴合代码，建议把现状和终局之间的差距明确拆开，不再把“当前可生产运行”和“最终通用平台终态”混在一起。

### 当前已完成

* 统一 action schema
* 统一 runtime loop
* consultation / application / review 三域接入 runtime
* phase policy 限制 agent / action / tool
* subagent registry / permission scope / output contract
* delegate_subagent
* sequential / parallel fan-out
* verifier / aggregator / arbitration 基础闭环
* fallback / resume / checkpoint / replay
* approval gate / 运维审批视图 / 审批决策审计
* run cost / tokens dashboard
* provider / model / tool 熔断
* kill switch
* 审计、脱敏、预算、lease、运维控制表
* review 草稿化、禁止自动审批
* cross-domain contract / gate（默认关闭）
* subagent execution envelope（独立预算、计数、能力元数据）

### 当前仍未完成（相对“完全开放式通用多 Agent 平台终态”）

* 通用型 Coordinator / Planner，不再绑定 consultation / application / review 固定业务域
* 递归自治子 runtime（子代理可独立多轮、多工具、多层委派）
* 真正可控的跨域协同（target_phase 驱动，而不是默认同 phase 安全协作）
* 共享 artifact / evidence graph / memory graph
* tool semantic registry（读 / 写 / 外部副作用 / 幂等 / 可补偿）
* 补偿事务 / saga / rollback 框架
* 多策略冲突仲裁 / 协商 / 共识机制
* 长时运行 workflow / scheduler / wait-resume 编排
* action / llm_call 级别的统一 replay 与可视化运维链路
* 多租户隔离、平台级沙箱与插件化 capability discovery
* 统一评测、回归、SLA gate 与策略压测能力

这个清单能明显减少后续沟通偏差：

> **你现在已经达到“系统级、可生产运行、带治理边界的多 Agent 协同”，但还没有达到“完全开放式通用多 Agent 平台终态”。**

---

# 十二、我对你项目当前阶段的更新判断

如果按你原蓝图的 P0 ～ P5 路线看，你实际上已经越过了“底座搭起来”和“生产治理补齐”的阶段。

你现在真正的分水岭不再是：

> **从 graph 主导转向 runtime 主导**

而是：

> **从“受治理的业务多 Agent runtime”升级为“通用开放式多 Agent 平台”。**

这个升级不是简单再补几个角色，而是四个层次一起抬升：

* **从 phase 绑定协调者，升级为通用任务规划器**
* **从子任务执行包裹，升级为递归自治子 runtime**
* **从字段级状态拼装，升级为 artifact / evidence / memory 图模型**
* **从单点运维能力，升级为平台级工作流、治理、评测与生态**

也就是说，你后面的重点已经不是“再做一个 batch 的功能”，而是把现有能力抽象成真正的平台层。

---

# 十三、如果要达到“完全开放式通用多 Agent 平台终态”，还需要补什么

下面这些不是在否定你当前系统，而是在定义：**从当前系统级协同，继续走到通用平台终态，还需要哪些新增能力。**

---

## 13.1 通用 Coordinator / Planner 层

### 当前状态

当前 coordinator 仍然和业务域强绑定：

* consultation -> `supervisor`
* application -> `application_assist`
* review -> `review`

### 终态目标

把 coordinator 提升成真正的**通用任务规划器**，而不是 phase 内固定协调者。

### 需要新增

* `task-graph-planner.ts`
* `coordinator-registry.ts`
* `workflow-scheduler.ts`
* capability-based worker selection
* dependency DAG / task graph
* goal / constraint / dependency / retry policy 的统一描述结构

### 验收

* 同一个 coordinator 可以根据任务目标动态选择 worker，而不是写死 phase -> agent 映射
* coordinator 可以拆出顺序任务、并行任务、条件任务、等待任务
* 不同业务域共用同一套任务规划抽象，而不是各写一套业务 coordinator prompt

---

## 13.2 递归自治子 runtime

### 当前状态

当前子代理已经有 execution envelope、预算、计数与能力元数据，但本质仍然是**一次 handler 包裹**。

### 终态目标

子代理本身也能拥有：

* 自己的 action loop
* 自己的 message history
* 自己的 tool loop
* 自己的 checkpoint / resume
* 自己的下级 delegation（受治理约束）

### 需要新增

* `nested-agent-runtime.ts`
* `subagent-session.repository.ts`
* parent-child budget propagation
* nested checkpoint lineage
* subagent local memory / scratchpad contract

### 验收

* 子代理可以独立执行多轮 `call_tool / update_plan / delegate_subagent / request_human / respond_final`
* 父子代理之间有稳定的 budget 传递与回收机制
* 子代理失败不会直接把父代理打崩，而是能带失败态回 fan-in

---

## 13.3 真正可控的跨域协同

### 当前状态

你已经有 cross-domain contract / gate，但默认仍然关闭，而且真实执行基本仍然是同 phase 内协同。

### 终态目标

支持“**显式 target_phase 驱动的跨域协同**”，同时保持安全边界不被打穿。

### 需要新增

* `cross-domain-routing.ts`
* `target_phase` / `target_domain` / `intent_scope` 明确入参
* 只读跨域、草稿跨域、写操作跨域三级策略
* cross-domain approval policy
* cross-domain audit lineage

### 验收

* consultation 可以显式召回 review / application 域 worker，但必须带 contract
* 不同域的数据读取、证据使用、审批权限可分别约束
* 默认仍关闭自由跨域，只有明确 contract 才放开

---

## 13.4 共享 artifact / evidence / memory graph

### 当前状态

你已经有很多 artifact 字段，但仍主要是“state 上挂一组字段”。

### 终态目标

把多 Agent 协作的共享层，从字段集合升级为**带所有权、版本、依赖、证据来源的图模型**。

### 需要新增

* `artifact-graph.ts`
* `evidence-ledger.ts`
* `memory-graph.ts`
* artifact owner / reader / writer / provenance model
* versioned artifact snapshots
* artifact conflict detection / merge policy

### 验收

* 任一最终结论都能追溯到具体 artifact 与 evidence provenance
* 不同 agent 对同一 artifact 的读写有明确 owner 与 merge rule
* parallel fan-out 不再依赖手写字段 merge，而是走统一 artifact graph merge

---

## 13.5 Tool semantic registry 与补偿事务框架

### 当前状态

你已经有 tool registry、approval gate、side-effect 分类，但工具语义还没完全平台化。

### 终态目标

每个 tool 不只是“可调用”，还应具备平台级语义：

* read_only
* draft_only
* approval_required
* external_mutation
* idempotent
* compensatable
* irreversible

### 需要新增

* `tool-semantic-registry.ts`
* `side-effect-policy.ts`
* `compensation-runner.ts`
* `saga-orchestrator.ts`
* rollback / compensation / retry matrix

### 验收

* 任意 side-effect tool 在运行前都能自动决定：是否可调、是否要审批、是否要补偿记录
* mutating tool 失败后可走 compensation / rollback，而不是只记日志
* 运维可以按 tool semantic class 统一下发策略

---

## 13.6 多策略冲突仲裁 / 协商 / 共识机制

### 当前状态

你已经有 arbitration 基础，但目前仍更偏单一规则化仲裁。

### 终态目标

支持多种协商与仲裁策略，而不只是一条固定裁决路径。

### 需要新增

* `arbitration-strategies.ts`
* vote / weighted vote / veto / debate / adjudicator 模式
* confidence calibration
* contradiction clustering
* human escalation policy DSL

### 验收

* 可以按任务类型切换冲突仲裁策略
* 并发多个 agent 给出不同结论时，不只会“转人工”，还可以先走策略化仲裁
* 仲裁过程本身可审计、可回放、可解释

---

## 13.7 长时运行 workflow / scheduler / wait-resume 编排

### 当前状态

你已经有 replay、resume、approval、fallback，但还不是一个通用长时 workflow 平台。

### 终态目标

支持跨分钟、跨小时、跨人工等待、跨外部事件的长时多 Agent 工作流。

### 需要新增

* `workflow-instance.repository.ts`
* `workflow-waits.repository.ts`
* timer / callback / external event wait node
* pause / park / wake / resume 通用状态机
* SLA / timeout / escalation policy

### 验收

* 一个多 Agent run 可以在等待审批、等待外部回调、等待人工材料补充时长期挂起
* 恢复点不是“整条 run 重来”，而是从具体 wait node 恢复
* 长时 workflow 有稳定的超时、催办、升级规则

---

## 13.8 平台级 observability / evaluation / regression gate

### 当前状态

你已经有 dashboard、审计、observability 视图，但评测体系还没完全平台化。

### 终态目标

把“能跑”升级为“**可持续验证、可持续回归、可持续压测**”。

### 需要新增

* `agent-eval-harness.ts`
* golden traces / scenario packs
* action-level replay viewer
* cost / latency / fallback / approval backlog SLA gate
* contract conformance tests
* chaos / fault injection / dependency outage drills

### 验收

* 每次改 orchestration contract、tool semantic、budget policy，都能自动跑回归集
* 运维可以看到 action / tool_call / llm_call 级别的完整 replay 轨迹
* 平台升级前有明确的 SLA 与回归门禁，而不是只看单测通过

---

## 13.9 多租户隔离与平台生态开放

### 当前状态

当前已经是系统级协同，但更像“本项目内的企业级实现”，还不是通用平台产品。

### 终态目标

支持多租户、多策略、多插件、多能力包接入。

### 需要新增

* `tenant-policy-registry.ts`
* `agent-package-registry.ts`
* capability discovery API
* MCP / plugin / prompt package versioning
* tenant-level isolation / quota / policy / sandbox

### 验收

* 不同租户可以有不同 orchestration policy / approval policy / tool policy
* 新 agent / tool / prompt 能以“能力包”方式接入，而不是改主链路源码
* 平台可以演进成“业务之上的通用多 Agent 基础设施”

---

# 十四、建议新增的后续阶段（P6 ～ P9）

为了避免一下子把“完全开放式通用平台”做散，建议在蓝图里继续分四段推进：

## P6：通用编排抽象层

* 通用 Coordinator / Planner
* task graph / dependency DAG
* 统一 artifact graph 雏形

## P7：递归自治与跨域协同

* nested runtime
* target_phase 驱动的跨域协同
* 子代理独立 checkpoint / resume

## P8：工具语义、补偿事务与协商仲裁

* tool semantic registry
* compensation / saga
* arbitration strategies / consensus

## P9：平台产品化与生态开放

* workflow / scheduler / wait-resume
* action-level replay / eval / SLA gate
* tenant isolation / capability discovery / plugin registry

---

# 十五、我对你后续演进的最终建议

你现在已经不是“要不要做多 Agent”，而是进入了：

> **如何把当前系统级多 Agent 协同，抽象成通用开放式多 Agent 平台。**

所以接下来最重要的不是继续补局部功能，而是把下面三件事做对：

* **把任务规划从业务域抽象出来**
* **把共享状态从字段集合升级为 artifact / evidence / memory 图**
* **把治理、评测、补偿、生态做成平台层，而不是业务层特判**

只有完成这一步，你的系统才会从：

> **系统级、可生产运行、带治理边界的多 Agent 协同**

真正升级成：

> **完全开放式、通用化、可扩展、可持续演进的多 Agent 平台终态**
