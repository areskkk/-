
## 2. 但它目前更像“受控 LLM 图工作流”，不是完整 Agent Tool Calling

你前面问的关键点是：

> LLM 是否知道工具存在？
>
> LLM 是否能根据上下文选择调用它？
>
> 工具调用是否经过 Schema 校验？
>
> 工具调用是否记录到 agent_tool_calls？

按这个标准看，你项目当前是：

| 判断项                              | 当前实现                                                          | 成熟度 |
| ----------------------------------- | ----------------------------------------------------------------- | ------ |
| LLM 知道工具存在                    | 部分知道，主要通过 prompt 文本和上下文知道，不是标准 tools schema | 中     |
| LLM 根据上下文选择工具              | 大多数不是，图代码固定调用工具                                    | 低     |
| 工具调用 Schema 校验                | Agent 输出有 Schema，工具输入本身没有统一 Schema 校验层           | 中低   |
| 工具调用记录到 `agent_tool_calls` | 有，图内工具会记录                                                | 高     |
| 工具调用上限                        | 配置存在，但未看到实际统一执行                                    | 低     |
| 通用 tool-runner                    | 文档有，但代码里没看到真正 `tool-runner.ts`                     | 低     |

---

## 3. 当前“工具”主要是 Graph-controlled Tool

也就是：

> 代码图固定调用工具，不是 LLM 自己请求调用工具。

例如政策咨询的 RAG 工具在 [consultation-graph-runner.ts:290-356](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/consultation-graph-runner.ts#L290-L356)。

这里逻辑是：

```text
runRetrievalPlanner LLM 生成 query
-> 代码固定执行 runRagTool
-> runRagTool 调 ragService.search
-> recordToolCall rag.search
```

这比普通 workflow 强一些，因为 query 是 LLM 规划出来的；但工具调用本身不是 LLM 输出的 `call_tool` 动作，而是图代码固定下一步调用。

申请里的 OCR 工具在 [application-graph-runner.ts:353-420](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/application-graph-runner.ts#L353-L420)。

规则引擎工具在 [application-graph-runner.ts:472-552](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/application-graph-runner.ts#L472-L552)。

审核里的规则引擎工具在 [review-graph-runner.ts:192-276](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/review-graph-runner.ts#L192-L276)。

这些都记录了 `agent_tool_calls`，但调用方式是：

```text
Graph Runner 固定调用 service
```

不是：

```text
LLM 输出 tool_call
-> Tool Runner 校验
-> Tool Runner 执行
```

所以这叫  **受控图工具** ，不是完整的  **Agent-requested tool** 。

---

## 4. 当前多 Agent 是“多角色顺序图”，不是“多 Agent 自主协作”

你已经有多角色：

* supervisor
* retrieval_planner
* policy_analysis
* application_assist
* document_vision
* math_verification
* review
* risk_judge

但这些 Agent 之间没有真正对话、协商、并行或委派。

现在是代码顺序串起来：

```text
代码调用 A
代码调用 B
代码调用工具
代码调用 C
代码调用 D
```

这属于：

> 多 Agent graph workflow

还不是：

> 多 Agent autonomous collaboration

区别如下：

| 能力                            | 当前项目                                 |
| ------------------------------- | ---------------------------------------- |
| 多个 Agent 角色                 | 有                                       |
| 每个 Agent 独立 prompt / model  | 有                                       |
| Agent 间消息传递                | 基本没有，靠 state 传递                  |
| Agent 并行执行                  | 没看到                                   |
| Supervisor 动态选择下一个 Agent | 名义上有 `next_node`，但主流程基本固定 |
| Agent 自主请求工具              | 基本没有                                 |
| Agent 自主创建子任务 / 子 Agent | 没看到                                   |
| 人工 fallback 后真实 resume     | 有一部分                                 |

尤其是 supervisor 的 `next_node` 目前只是存进 state，例如 [consultation-graph-runner.ts:247-252](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/consultation-graph-runner.ts#L247-L252)，但主流程仍然固定继续执行 [consultation-graph-runner.ts:64-74](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/consultation-graph-runner.ts#L64-L74)。

所以 supervisor 现在更像“意图分类记录节点”，还不是“真正控制图路径的调度 Agent”。

---

## 5. Resume 已实现，但还不是文档里的完整恢复契约

好的一面：

[agents.service.ts:469-487](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/agents.service.ts#L469-L487) 已经按 entrypoint 分发真实 resume：

* consultation resume
* application resume
* review resume
* mock resume

这比 mock resume 已经强很多。

但是细看各图 resume，还是偏简化。

### 5.1 consultation resume 偏人工填答案 / citation

[consultation-graph-runner.ts:117-226](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/consultation-graph-runner.ts#L117-L226) 主要支持：

* `manual_citation`
* `answer`

然后再跑 risk judge 或直接 final。

但文档里说的：

```text
corrected_query / selected_policy_id / manual_citation
-> rag_tool 或 policy_analysis
-> risk_judge
-> final
```

当前代码没有完整实现 `corrected_query -> rag_tool -> policy_analysis` 这条恢复路径。

---

### 5.2 application resume 实现了后半段恢复

[application-graph-runner.ts:162-244](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/application-graph-runner.ts#L162-L244) 会：

```text
human_fallback_resume
-> applyApplicationManualResume
-> eligibility_tool
-> math_verification
-> risk_judge
-> final
```

这已经比较接近真实恢复。

不过它没有重新跑：

* policy_analysis
* application_assist
* document_vision

它主要从规则校验后半段恢复。

---

### 5.3 review resume 有实现，但 review 正常路径没有明显 fallback interrupt

[review-graph-runner.ts:98-149](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/review-graph-runner.ts#L98-L149) 支持 resume 后：

```text
eligibility_tool
-> document_vision
-> math_verification
-> risk_judge
-> draft_review_opinion
```

但 review 的正常 run 在 [review-graph-runner.ts:82-95](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/review-graph-runner.ts#L82-L95) 无论 risk judge 怎么判断，都会继续生成草稿，没有看到类似 application 的 `shouldInterrupt(state)` fallback 分支。

所以 review 图目前更像：

> 永远生成“带风险提示的草稿”，而不是“高风险中断进入人工 fallback”。

这与文档里的“审核草稿生成前需要人工补充材料或确认 OCR 时中断”还有差距。

---

## 6. 当前最关键缺口

### 缺口 1：没有真正的通用 Tool Runner

文档里提到最终目录应有：

```text
src/modules/agents/tools/tool-runner.ts
```

但当前 Glob 结果里没有 `src/modules/agents/tools/` 这一套。

现在工具调用散落在各个 graph runner 里，例如：

* [consultation-graph-runner.ts:290-356](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/consultation-graph-runner.ts#L290-L356)
* [application-graph-runner.ts:353-420](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/application-graph-runner.ts#L353-L420)
* [application-graph-runner.ts:472-552](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/application-graph-runner.ts#L472-L552)
* [review-graph-runner.ts:192-276](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/review-graph-runner.ts#L192-L276)

这意味着：

* 工具没有统一注册表
* 没有统一 allowedToolsByAgent
* 没有统一输入 Schema
* 没有统一调用上限
* 没有统一错误分类
* 没有统一 tool result 回灌协议

这是“Agent 工具调用能力”最主要短板。

---

### 缺口 2：LLM 没有原生 tool call / function call 协议

当前 LLM 调用统一是：

```text
response_format: json_object
```

见 [bailian.client.ts:84-93](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/llm/bailian.client.ts#L84-L93)。

Agent 输出是某个节点的最终 JSON，比如 `RiskJudgeOutput`、`PolicyAnalysisOutput`。

但没有这种协议：

```json
{
  "action": "call_tool",
  "tool_name": "rag.search",
  "tool_input": {}
}
```

也没有后端循环：

```text
LLM -> call_tool -> tool_result -> LLM -> final
```

所以当前 Agent 能力主要是：

```text
一个 LLM 节点输出结构化判断
```

而不是：

```text
一个 Agent 在节点内部多轮选择工具、执行工具、根据结果继续思考
```

---

### 缺口 3：工具调用上限配置存在，但没有统一执行

环境变量里有：

[env.ts:160-161](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/config/env.ts#L160-L161)

```text
AGENT_MAX_GRAPH_STEPS
AGENT_MAX_TOOL_CALLS_PER_AGENT
```

但我搜索到 `agentMaxToolCallsPerAgent` 只在配置里出现，没有在实际工具调用路径中统一判断。

这说明“工具调用上限”还更多是配置占位，未真正成为 runtime guardrail。

---

### 缺口 4：图步数上限也没有看到统一执行

同样，[env.ts:160](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/config/env.ts#L160) 有 `agentMaxGraphSteps`，但没有看到 graph runner 每执行一步都检查总步数。

现在每条图是固定短链路，所以暂时风险不大；但如果后续引入动态 tool loop，就必须实现，否则容易失控。

---

### 缺口 5：Prompt 版本记录还不完整，但需要修正判断依据

现在 step 里有 `prompt_template_id`，并把 `prompt_version` 放到了 step input 中，例如 [application-graph-runner.ts:673-691](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/application-graph-runner.ts#L673-L691)。

但表结构 [010_batch17_agent_runtime.sql:23-41](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/db/migrations/010_batch17_agent_runtime.sql#L23-L41) 里没有单独的 `prompt_version` 字段。

需要注意：后续 [014_agent_enterprise_production_controls.sql](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/db/migrations/014_agent_enterprise_production_controls.sql#L48-L60) 已经新增了 `agent_llm_calls.prompt_version`，并且 [agent-runtime-controls.ts:263-289](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/agent-runtime-controls.ts#L263-L289) 会记录 LLM 调用版本。

所以更准确的判断是：

* LLM call 级别已经能记录 `prompt_version`
* agent step 级别还没有独立字段记录 `prompt_version`
* `prompt_status` 和 `rendered_variables_summary` 还没有形成稳定字段
* [step-recorder.ts:44-50](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/step-recorder.ts#L44-L50) 的 audit detail 里 `prompt_version` 实际写入的是 `prompt_template_id`，这里需要修正

文档要求每次 step 必须记录：

* prompt_template_id
* prompt_version
* prompt_status
* rendered_variables_summary

当前是部分满足。

---

### 缺口 6：政策咨询入口传入的 actor 上下文偏弱

[policy-qa.service.ts:234-247](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/policy-qa/policy-qa.service.ts#L234-L247) 调用 `agentRunService.startRun` 时传：

```text
roles: []
```

而且 input 只传了：

* question
* policy_id

没有传 enterprise_id。

如果政策咨询未来要按企业归属、角色或画像权限做隔离，这里还不够。

---

### 缺口 7：review Agent 没有中断 fallback 分支

如上所说，[review-graph-runner.ts:82-95](vscode-webview://1p4gl2bgt19bcp07p0umn9uc70s67eomauvh4ldp9334dpdgitp3/src/modules/agents/runtime/review-graph-runner.ts#L82-L95) 总是走到 `draft_review_opinion`。

这符合“只生成草稿、不自动审批”，但不完全符合“高风险必须 fallback / 人工补充后 resume”。

当前 review 更像：

> 安全地生成草稿，但不是完整人机中断恢复图。

---

## 7. 按能力打分

| 能力项             | 当前水平 | 评价                                                |
| ------------------ | -------- | --------------------------------------------------- |
| 云端 LLM 接入      | 8/10     | 百炼兼容接口、超时、重试、JSON 解析都有             |
| 多 Agent 角色      | 8/10     | 多角色已经清晰                                      |
| 多 Agent 图编排    | 7/10     | 三条图都有，但路径基本固定                          |
| Agent 自主工具调用 | 3/10     | 工具主要由图固定调用                                |
| 工具调用审计       | 8/10     | `agent_tool_calls` 已有                           |
| 工具 Schema 校验   | 4/10     | Agent 输出有校验，工具输入缺统一校验层              |
| Prompt 配置化      | 6/10     | DB active 已接，记录还不完整                        |
| 模型配置化         | 8/10     | `model_finalization_records` 优先已实现           |
| 权限隔离           | 7/10     | 核心有了，政策咨询上下文偏弱                        |
| Resume             | 6/10     | 真实分发有了，图内恢复还偏简化                      |
| 异步队列 / Worker  | 8/10     | 已有租约、heartbeat、stale 防护                     |
| 成本预算 / 限流    | 7/10     | 预算、quota、daily reservation 已有，工具上限未落实 |
| 观测               | 7/10     | LLM call / step / tool call / view 已有             |
| MCP 化             | 0/10     | 当前不是 MCP，这不是问题，只是事实                  |
| 企业级生产完整度   | 6.5/10   | 地基好，但 tool-runner 与动态 agent loop 缺失       |

---

## 8. 用一句话定义你现在的实现

我建议你现在对外不要说：

> 已实现完全自主多 Agent。

更准确应该说：

> 已实现基于云端 LLM 的生产化多角色 Agent 图编排运行时，具备三条业务链路、模型路由、Prompt 配置、结构化输出校验、受控业务工具调用、审计、权限、异步队列、预算与恢复地基；当前工具调用以图编排固定调用为主，尚未实现通用 tool-runner 驱动的 Agent 自主工具调用。

这句话最贴合代码事实。

---

## 9. 下一步最应该补什么

如果目标是让它更像真正 Agent，而不是固定算法，我建议下一步做这 4 件。

### P0：补通用 Tool Registry + Tool Runner

新增类似：

```text
src/modules/agents/tools/
  tool.types.ts
  tool-registry.ts
  tool-runner.ts
  rag.tool.ts
  eligibility.tool.ts
  material-read.tool.ts
  fallback.tool.ts
  audit.tool.ts
```

每个工具定义：

```ts
{
  name: 'rag.search',
  description: '当需要政策 citation 时调用',
  inputSchema: RagSearchInputSchema,
  allowedAgents: ['retrieval_planner', 'policy_analysis'],
  execute: async (input, context) => {}
}
```

Tool Runner 统一负责：

* allowed agent 校验
* Zod Schema 校验
* 权限上下文校验
* `AGENT_MAX_TOOL_CALLS_PER_AGENT`
* `agent_tool_calls` running / completed / failed
* 脱敏
* 错误分类

---

### P1：引入 Agent action 协议

如果百炼不稳定支持原生 tool calling，就用 JSON action 协议。

例如让 Agent 输出：

```json
{
  "action": "call_tool",
  "tool_name": "rag.search",
  "tool_input": {
    "query": "稳岗补贴 申请条件"
  },
  "reason": "当前 citation 不足"
}
```

或者：

```json
{
  "action": "final",
  "answer": "...",
  "confidence": 0.87
}
```

然后后端 loop：

```text
callJsonAgent
-> validate action
-> toolRunner.execute
-> append tool_result
-> callJsonAgent again
-> final/fallback
```

这样才是“Agent 自己选择工具”。

---

### P2：让 supervisor 真正控制图分支

现在 `next_node` 基本只是记录，后续可以改成：

```text
supervisor.next_node = retrieval_planner
supervisor.next_node = need_info
supervisor.next_node = human_fallback
supervisor.next_node = application_assist
```

Graph Runner 根据它走分支，而不是固定顺序。

---

### P3：补 review fallback interrupt

审核图应加：

```text
risk_judge.should_fallback=true
或 OCR 低置信
或 missing_evidence 高风险
-> human_fallback
```

再允许 resume 后继续：

```text
document_vision / eligibility / risk_judge / draft_review_opinion
```

否则 review resume 虽然有代码，但真实中断入口不足。

---

## 10. 如果目标是企业生产级多 Agent，还必须补齐的缺口

上面 P0-P3 主要解决“让它更像真正 Agent”的核心问题，但还不能等同于完整企业生产级。企业生产级至少还要补齐以下缺口。

### P0：统一 Agent Runtime Guardrail

一旦引入 Agent action loop，必须先补运行时硬护栏：

* 每个 run 的最大 graph step 数必须统一检查 `AGENT_MAX_GRAPH_STEPS`
* 每个 agent 的最大工具调用数必须统一检查 `AGENT_MAX_TOOL_CALLS_PER_AGENT`
* 每轮 LLM + tool loop 必须有超时、最大轮数、最大 token、最大成本
* tool call 失败必须分类为 retryable / non_retryable / permission_denied / invalid_input / external_unavailable
* 超限后必须进入 final degraded 或 human_fallback，不能无限循环

验收标准：

```text
任意 Agent 进入动态 loop 后，即使模型一直要求 call_tool，也会被 runtime guardrail 截断并留下审计记录。
```

---

### P0：工具级权限、租户隔离和数据脱敏

通用 Tool Runner 不能只做工具分发，还必须做企业级安全控制：

* 每个工具必须声明 `allowedAgents`
* 每个工具必须声明 `requiredPermissions`
* 每次工具执行必须带 actor / roles / enterprise_id / trace_id / run_id
* Tool Runner 必须校验企业归属，不能只依赖上游 service 假定
* 工具 input / output 入库前必须统一脱敏
* 工具不得把 OCR 低置信字段当作硬证据返回给规则引擎

验收标准：

```text
跨企业 policy_id / application_id / item_id 传入工具时，Tool Runner 层直接拒绝，并记录 agent_tool_calls failed。
```

---

### P0：工具输入输出 Schema 和结果回灌协议

当前 Agent 输出有 Schema，但工具输入缺统一 Schema。企业级需要：

* 每个 tool 有独立 input schema
* 每个 tool 有独立 output schema
* tool result 有统一 envelope，例如 `status / data / citations / warnings / error`
* tool result 回灌给 LLM 前必须裁剪、脱敏、限制长度
* tool result 必须能关联到 step、run、trace、actor

验收标准：

```text
LLM 输出非法 tool_input 时，不会进入业务 service，而是在 Tool Runner 层失败并可审计。
```

---

### P1：Agent action loop 和可恢复状态机

只有 Tool Runner 还不够，还需要明确 Agent 自主循环协议：

```text
agent_action = call_tool | final | ask_human | handoff | abort
```

必须补齐：

* action schema 校验
* action loop 状态持久化
* 每次 tool_result 后重新调用 LLM 的上下文裁剪规则
* `ask_human` 后的 interrupt / resume 契约
* resume 后从哪个 action / node 继续，而不是只从固定后半段继续

验收标准：

```text
consultation 可以从 corrected_query resume 后重新 rag.search，再 policy_analysis，再 risk_judge，再 final。
```

---

### P1：Supervisor 真正路由和状态机化

当前 supervisor 的 `next_node` 主要是记录。企业级需要让它成为真实路由依据：

* 定义允许跳转表，禁止模型随意跳不存在节点
* supervisor 输出必须通过路由 schema 校验
* 高风险节点不能被 supervisor 跳过
* 每次路由决策必须记录 reason / confidence / alternatives
* 低置信度路由进入 human_fallback 或 clarifying question

验收标准：

```text
supervisor.next_node=human_fallback 时，graph 不再继续固定跑 retrieval_planner。
```

---

### P1：Human-in-the-loop 契约补全

项目已有 fallback / resume 地基，但还不是完整企业契约。需要补：

* consultation 支持 corrected_query / selected_policy_id / manual_citation / manual_answer
* application 支持 corrected_fields / confirmed_materials 后重新跑必要 Agent
* review 在 draft_review_opinion 前支持高风险中断
* 每类 fallback task 有明确 payload schema
* resume_payload 非法时不能静默降级
* 人工确认记录必须能追溯到具体 actor 和时间

验收标准：

```text
高风险 review 不生成草稿，先进入 human_fallback；人工补齐后才继续生成 draft_review_opinion。
```

---

### P1：Prompt、模型、工具的完整可追溯

企业生产级不仅要能跑，还要能复盘。需要补：

* `agent_run_steps` 独立记录 prompt_version
* 记录 prompt_status
* 记录 rendered_variables_summary
* 修正 step audit 里 `prompt_version` 写成 `prompt_template_id` 的问题
* 每个 tool call 记录 tool version 或 implementation version
* 模型路由结果、fallback 模型、降级原因必须可查询

验收标准：

```text
任意 final answer 都能追溯到每个 step 使用的 prompt、模型、工具输入输出、引用和人工确认记录。
```

---

### P1：测试和验收场景补齐

当前不能只靠代码阅读判断生产级。至少要补：

* Tool Runner 单测：权限、schema、上限、脱敏、错误分类
* Agent action loop 单测：call_tool / final / ask_human / abort
* consultation 端到端：有 citation、无 citation、corrected_query resume
* application 端到端：低置信 OCR、规则冲突、manual resume
* review 端到端：高风险中断、resume 后生成草稿
* 并发 worker 测试：lease、heartbeat、stale job、重复 resume
* 成本和限流测试：daily budget、per-run budget、tool-call limit

验收标准：

```text
npm test 覆盖动态 tool loop、fallback resume、权限隔离和成本上限，不只是 mock completed。
```

---

### P2：多 Agent 协作能力，而不只是顺序图

如果目标是“自主协作型多 Agent”，还要补：

* Agent 间消息协议
* handoff 协议
* 并行 Agent 执行和结果汇总
* 子任务拆解和子任务状态表
* 冲突解决策略，例如 policy_analysis 与 risk_judge 不一致时如何裁决
* 多 Agent 共享 memory 的读写边界

验收标准：

```text
多个 Agent 可以并行产出独立结论，由 supervisor 或 aggregator 合并，并在冲突时进入人工复核。
```

---

### P2：生产运维和质量治理

企业级还需要运维侧闭环：

* Agent run 指标面板：成功率、fallback 率、工具失败率、平均成本、平均耗时
* 模型质量评估集：政策问答、申请材料、审核草稿分别评估
* 回放能力：按 run_id 重放状态，不重复写业务副作用
* 灰度开关：按 entrypoint / enterprise / role 开启 Agent loop
* 降级策略：LLM 不可用时回退 legacy workflow 或人工
* 安全审计：敏感字段、跨租户访问、异常工具调用告警

验收标准：

```text
某个模型或工具故障时，系统能自动降级，不影响基础业务链路，并能在观测面板定位原因。
```

---

## 11. 验证说明

这次我做的是代码阅读评估， **没有运行测试** 。我主要读取了：

* Agent 服务与路由
* 三条 graph runner
* LLM provider / 百炼 client
* 模型路由
* Prompt repository
* Step / ToolCall recorder
* 权限模块
* Worker / runtime controls
* 相关 migration
* batch21 / batch22 测试片段

所以结论是“基于代码事实的成熟度评估”，不是完整可提交审查。当前如果要宣称“生产级多 Agent 完整”，我认为还不能；如果宣称“已具备多 Agent 生产化地基和受控图编排能力”，是成立的。
