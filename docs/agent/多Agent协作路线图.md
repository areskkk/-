# 一句话先说清

## 你现在做的是：

**让某个节点里的 LLM，可以自己决定是否调用工具。**

## 全局自主 Agent loop 是：

**让整个 Agent 运行时，不再主要依赖固定 graph 决定下一步，而是由 LLM/agent runtime 持续“观察状态 → 选择动作/工具/子代理 → 执行 → 继续直到结束”。**

---

# 两者的架构区别

## 1）受控 / 局部 LLM 原生 tool call loop

这是你现在缺口 2 的东西。

典型形态：

* graph 还是固定的
* 只有某个节点里允许 LLM 发 tool call
* tool call 的 scope、次数、可用工具、结果格式，都是外部代码强约束
* node 结束后，流程还是回到既定 graph

比如你现在的咨询链路更像：

```text
supervisor
  -> retrieval_planner（这里允许 LLM 调 rag.search）
  -> policy_analysis
  -> risk_judge
  -> final
```

这里虽然 retrieval_planner 已经“更智能”了，但 **全局流程的骨架还是代码决定的** ，不是模型决定的。

### 这个层级的特点

* **工具是局部自治**
* **流程是全局受控**
* 更像“固定流水线里某个工位变聪明了”

---

## 2）全局自主 Agent loop

这是另一层级。

典型形态不是“先 supervisor 再 planner 再 judge”，而是：

```text
while not done:
  读取当前状态
  让 agent 决定下一步做什么
    - 调哪个工具
    - 是否继续检索
    - 是否切换子任务
    - 是否需要子代理
    - 是否请求人工
    - 是否可以结束
  执行动作
  把结果写回上下文/状态
```

也就是说， **“下一步去哪儿”这件事本身，也被 agent 接管了** 。

### 这个层级的特点

* **工具调用是自主的**
* **步骤选择也是自主的**
* **停止条件、回退、重试、子代理协作，都要进入统一 runtime**
* graph 不再是主逻辑，只剩“护栏”和“状态机底座”

---

# 核心区别，不在“有没有 tool call”，而在“谁控制流程”

可以用一个简单表来区分：

| 维度             | 局部 tool call loop     | 全局自主 Agent loop                |
| ---------------- | ----------------------- | ---------------------------------- |
| 谁决定是否调工具 | 当前 node 内的 LLM      | Agent runtime 中的 LLM             |
| 谁决定下一步节点 | 固定 graph / 代码       | Agent 自己                         |
| 工具范围         | 某一节点白名单          | 全局按角色/阶段动态开放            |
| 停止条件         | 当前 node 结束          | 整个任务完成 / 人工介入 / 预算耗尽 |
| 状态推进         | graph 代码推进          | agent runtime 推进                 |
| 回退机制         | 代码写死                | agent + runtime 联合决定           |
| 多 agent 协作    | 通常没有，或 graph 写死 | 可动态委派/回收结果                |
| 复杂度           | 中                      | 很高                               |

---

# 为什么“LLM 原生 tool call”不等于“全局自主 Agent loop”

因为 tool call 只解决了 **一个能力点** ：

> “模型不只是吐文本，它还能请求调用工具。”

但全局自主 loop 还要解决另外几类问题：

---

## A. 决策层问题：下一步做什么

局部 tool call 只回答：

> “这个 node 里要不要调工具？”

全局自主 loop 要回答：

* 现在是继续检索，还是直接回答？
* 是先 OCR 还是先 eligibility？
* 是请求人工补件，还是继续 ask tool？
* 是交给 subagent，还是自己继续？
* 什么时候任务算完成？

这不是 tool call 协议本身能解决的。

---

## B. 状态层问题：整个任务怎么记忆和推进

局部 loop 通常只看本 node 的消息和 tool result。

全局自主 loop 需要统一处理：

* 当前 run 的全局 state
* 历史步骤
* 已执行过哪些工具
* 哪些结果可信，哪些只是低置信提示
* 哪些人工输入已经回灌
* 哪些子代理结果已经回来
* 哪些动作已经做过，不能再重复做

这已经不是“LLM 支持 tools”层面，而是**runtime / orchestration** 层面。

---

## C. 控制层问题：防失控

全局自主 loop 最大风险不是“不会调工具”，而是“调太多 / 调错 / 调不下来”。

你必须补：

* 每轮最多几次 tool call
* 总共最多几轮
* 总 token / 成本预算
* side effect 工具是否需要人工确认
* 是否允许重复调用同一工具
* 工具超时、失败、重试策略
* 死循环检测
* 低置信度降级
* fallback 任务幂等

这些护栏如果不统一，越“自主”越危险。

---

## D. 组织层问题：多 Agent 协作

“企业生产级多 agent 自主协作”比“单 agent 原生 tool call”又多一层：

* 谁来分解任务？
* 谁来挑选子代理？
* 子代理的权限边界是什么？
* 子代理能调用哪些工具？
* 结果怎么汇总？
* 多个子代理结论冲突时谁裁决？
* 如何防止多个 agent 互相放大错误？

所以：
**全局自主 Agent loop**

≠ **单 agent tool call loop**

**多 agent 自主协作**

又比前者更高一级。

---

# 你现在离哪里最近？

按你当前这几轮实现，我会这么分层：

---

## L0：固定 graph + 无原生 tool call

最早状态。

* 工具调用由代码写死
* LLM 只负责产出 JSON / 文本
* graph 决定所有步骤

---

## L1：固定 graph + 局部原生 tool call

这是你现在已经达到的层级。

* 某个 node（比如 retrieval_planner）可原生发 `rag.search`
* 工具 schema、tool result、回灌闭环成立
* graph 仍决定主流程
* 有 scope 注入和安全覆盖

这就是“ **受控/局部 LLM 原生 tool call loop** ”。

---

## L2：多节点原生 tool call，但仍是 graph 主导

下一步可能会到这里。

例如：

* consultation 的 retrieval_planner 可调工具
* application_assist 可调 OCR / eligibility
* review/document_vision 也可调工具
* 但 supervisor → planner → judge 的大流程还是 graph 决定

这仍然 **不是全局自主 loop** ，只是 graph 上更多节点支持 tool call。

---

## L3：统一 runtime 驱动的单 Agent 自主 loop

这才接近“全局自主 Agent loop”。

特征：

* 一个通用 `agent runtime loop`
* 不再为每个节点手写一套 callJsonAgent + tool loop
* “下一步动作”由 agent 决定
* graph 退化成状态护栏或阶段约束
* 支持统一的：
  * tool registry
  * step audit
  * budget
  * fallback
  * retry
  * permission
  * completion condition

---

## L4：多 Agent 自主协作 runtime

再往上才是你说的“企业生产级多 agent 自主协作”。

特征：

* coordinator agent
* worker/subagent agent
* 任务分解、委派、回收、验证、合并
* 不同 agent 有不同 tools / scope / memory / budget
* 支持人工中断、审批、审计和回放

---

# 所以，“把所有缺口补齐”能不能达到全局自主 Agent loop？

## 短答：

**看你说的“所有缺口”是不是只包含当前列出来的工程缺口。**

如果只是你目前这几轮在补的缺口：

* 通用 Tool Runner
* 原生 tool call
* consultation 接入
* 权限/回退/回归测试

那答案是：

> **不能直接达到。**
> 你只能达到“受控局部原生 tool call 已可生产收口”的状态。

---

## 更准确地说

### 这些缺口补齐后，你会得到：

* 稳定的工具注册和执行底座
* 原生 tool call 协议
* 某些链路的局部自治
* 审计、权限、回退、测试闭环

### 但还缺：

* **统一的自主决策 runtime**
* **任务级停止条件**
* **全局状态驱动**
* **跨节点/跨工具的计划与反思**
* **多 agent 委派协议**
* **预算与死循环控制**
* **更细的 side-effect 审批模型**
* **上下文管理 / memory 策略**
* **真正的任务完成判定**

所以它不是“补完几个缺口自然跃迁”，而是 **从底座能力到运行时架构的跨层升级** 。

---

# 从你当前状态演进到“全局自主 Agent loop”，最少还要补哪些类目

我按工程顺序给你拆一下。

---

## 第一类：统一 runtime loop，而不是每个 graph 节点单独接 tool call

你现在是：

* retrieval_planner 里单独接 `runAgentToolLoop`
* 其他节点还是固定式 `callJsonAgent`

要进到全局自主 loop，至少要抽成：

* 统一的 agent turn executor
* 给定 state / allowed actions / tools
* agent 决定：
  * 输出 final
  * 调 tool
  * 请求 human fallback
  * 进入 next phase
  * 结束 run

也就是把“下一步去哪儿”的控制权，逐步从 graph 挪到 runtime。

---

## 第二类：动作空间（action space）设计

全局 loop 不是只有 tools，还要有“动作”。

至少要区分：

* `call_tool`
* `respond_final`
* `request_human`
* `delegate_subagent`
* `update_plan`
* `stop_with_manual_review`

否则模型只能在“调工具 / 不调工具”之间选，不是真正的 agent loop。

---

## 第三类：全局停止条件

局部 tool loop 的停止条件很简单：

* 没有 tool_call
* 或达到最大轮数

全局自主 loop 必须定义：

* 什么叫任务完成？
* 什么叫需要人工接管？
* 什么叫继续尝试？
* 什么叫卡死？
* 什么叫信息不足？

否则会出现“能一直干，但不知道什么时候停”。

---

## 第四类：预算 / 护栏 / 幂等

这是生产级必须有的。

至少包括：

1. **总轮数上限**
2. **总 token / 成本预算**
3. **每工具最大调用次数**
4. **同参数重复调用去重**
5. **fallback 幂等**
6. **side-effect confirmation**
7. **异常分类与重试矩阵**
8. **死循环与低收益循环识别**

现在你有一部分，但还没形成“全局 loop 级”的统一策略。

---

## 第五类：上下文管理

全局自主 loop 很容易上下文爆炸。

要考虑：

* 哪些 tool result 全量进上下文
* 哪些只进摘要
* 哪些只写 state 不进 prompt
* 哪些低置信结果不能直接喂给下游
* 哪些步骤完成后要裁剪历史
* 是否引入 memory / scratchpad

这是 Agent runtime 的核心问题之一，不是简单“支持 tools”就结束。

---

## 第六类：多 Agent 协议

如果目标是“企业生产级多 agent 自主协作”，还要补：

1. **协调者与执行者角色分离**
2. **子代理输入/输出 schema**
3. **子代理权限边界**
4. **结果验证者 / 裁判者**
5. **子代理预算**
6. **失败回收机制**
7. **并发与顺序控制**
8. **共享状态与隔离状态的划分**

否则只是“多个节点都能调工具”，还不是“多 agent 自主协作”。

---

# 你可以这样理解两者关系

## 原生 tool call 是“手脚”

模型终于能动手了。

## 局部 tool loop 是“一个工位会自己拿工具”

比如 retrieval_planner 自己会查知识库了。

## 全局自主 Agent loop 是“整个人会自己规划、行动、纠错、收尾”

不仅会拿工具，还会决定：

* 先干什么
* 干到什么时候
* 不会的时候找谁
* 失败后怎么退
* 何时交人工

## 多 Agent 自主协作是“一个团队会分工合作”

这又比单 Agent 再高一层。

---

# 我给你的实操判断标准

如果以后你想判断“现在到底只是局部 tool call，还是已经到了全局自主 Agent loop”，你可以问 5 个问题：

### 1. 下一步步骤是谁决定的？

* 如果是 graph/代码：还不是全局自主
* 如果是 agent runtime：更接近

### 2. 模型能否选择“调哪个工具”之外的动作？

* 只能 call_tool：还不够
* 能 request_human / stop / delegate / continue：更接近

### 3. 失败、重试、人工接管是 node 级还是 run 级统一处理？

* node 级零散处理：还不够
* run 级统一：更接近

### 4. 多个 agent 之间有没有正式协议？

* 没有，只是多个节点：不是多 agent 自主协作
* 有任务分发和回收协议：更接近

### 5. 去掉固定 graph 后，系统还能安全完成主要任务吗？

* 不能：说明还是 graph 主导
* 能：说明开始接近全局自主 loop

---

# 针对你当前项目，最现实的下一步

我建议你不要直接从现在跳到“全局自主多 agent”。

最稳的是：

## 第一步：把“局部原生 tool call”扩到更多节点

例如：

* consultation: retrieval_planner
* application: application_assist / document_vision
* review: document_vision / review
* risk_judge 如有必要再谨慎开放

但此时仍保持 graph 主导。

---

## 第二步：抽统一 agent runtime loop

把现在每个节点的：

* callJsonAgent
* runAgentToolLoop
* validate output
* recordStep
* fallback / interrupt

收成统一框架。

这一步完成，才算开始从“局部 tool loop”走向“全局自主 loop”。

---

## 第三步：把 graph 从“决定流程”降级成“约束阶段”

例如 graph 只规定：

* 当前 run 在 consultation/application/review 哪个 phase
* 允许哪些 action
* 允许哪些 tools
* 哪些结果必须人工确认

而不是死写：
`supervisor -> retrieval -> analysis -> judge`

---

## 第四步：再做多 agent 协作

最后才是：

* coordinator
* worker
* verifier
* human gate

---

# 最终回答

## 你的问题 1：

**“不扩成全局自主 Agent loop”和后面的“LLM 原生 tool call”有什么区别？**

区别是：

* **LLM 原生 tool call** ：模型能在某个步骤里请求调用工具
* **全局自主 Agent loop** ：模型/agent runtime 能决定整个任务接下来做什么，不只是调工具，还包括继续、停止、回退、请求人工、委派子代理等

前者是 **能力点** ，后者是 **运行时架构** 。

---

## 你的问题 2：

**“是不是我将所有缺口都补齐就可以达到全局自主 Agent loop？”**

答案是：

* **如果“所有缺口”只指你当前这几轮补的缺口，不够。**
* 这些缺口补完后，你能达到的是： **“受控局部原生 tool call 的最小生产闭环”**
* 要达到 **全局自主 Agent loop** ，还要继续补：
  * 统一 runtime 决策层
  * 全局动作空间
  * run 级停止条件
  * 预算与死循环控制
  * 上下文/记忆管理
  * 多 agent 协议
  * 人工审批和副作用控制

所以不是“把现在列出的缺口补完就自动跃迁”，而是 **先把底座补齐，再进行一次架构层升级** 。

---

如果你愿意，我下一条可以直接帮你把这件事整理成一张**“从当前状态 → 全局自主 Agent loop → 多 Agent 协作”的分阶段路线图**，按你这个项目现状拆成  **P0 / P1 / P2 / P3** 。

从当前状态 → 全局自主 Agent loop → 多 Agent 协作”的分阶段路线图    你给我写一个，后续我将根据这个路线图来让我的项目实现真正的多Agent协作

<details class="thinking_aHyQPQ thinkingV2_aHyQPQ"><div class="thinkingContent_aHyQPQ"><span class="root_-a7MRw"><p><strong></strong></p><p></p></span></div></details>

</details>

下面给你一个**从当前状态 → 全局自主 Agent loop → 多 Agent 协作**的分阶段路线图。

我会尽量按你这个项目的**现状代码结构**来写，不写空泛概念，后续你可以直接把它拆成 batch 让 Codex 按阶段落地。

---

# 一、先定义你当前所处的位置

按你现在的实现，我判断项目大致在：

## 当前阶段：**L1.5 ～ L2 之间**

你已经具备了这些能力：

### 已有底座

* 统一 `Tool Registry`
* 统一 `Tool Runner`
* 工具输入校验
* `allowedAgents` 校验
* 工具调用上限
* `agent_tool_calls` 成功/失败审计
* `rag.search / ocr.material_evidence.read / eligibility.rule_engine.check` 工具化
* LLM 协议支持 `tools / tool_choice / tool_calls / tool message`
* Bailian OpenAI-compatible function call 透传与解析
* `agent-tool-loop.ts` 的**受控工具循环**
* consultation 的 `retrieval_planner` 已接入原生 `rag.search` tool call
* 关键权限 / fallback / policy scope 回归已补上

### 但还不是的能力

* 还不是**全局自主 Agent loop**
* 还不是**多 Agent 自主协作 runtime**
* 还不是**企业级生产化的自治编排系统**

也就是说，你现在已经有了：

> **“一个可以在固定 graph 中局部自主调用工具的 Agent 底座”**

下一步不是“继续补零散功能”，而是要开始做 **runtime 架构升级** 。

---

# 二、目标拆分：你真正要达到的三个层级

---

## 目标 A：全局自主 Agent loop

含义：

* 不只是某个 node 里会调工具
* 而是 agent 能决定**下一步动作**
* 包括：
  * 调哪个工具
  * 是否继续查
  * 是否请求人工
  * 是否结束
  * 是否切换阶段

---

## 目标 B：多 Agent 协作

含义：

* 不只是一个 Agent 会自己跑
* 而是多个 Agent 有**明确角色和协作协议**
* 比如：
  * coordinator
  * retriever
  * document_vision
  * policy_analyst
  * risk_judge
  * review_drafter
* 它们之间能委派任务、交换结果、聚合裁决

---

## 目标 C：企业级生产化

含义：

* 即使 agent 自主程度提高，也不会失控
* 有预算、权限、审计、回放、熔断、降级、人工接管、租户隔离、测试门禁
* 可以真的在企业业务里长期跑

---

# 三、推荐路线图总览

我建议你按 **P0 → P1 → P2 → P3 → P4** 五个阶段走。

---

# P0：把“局部原生 tool call”底座打结实

> 目标：把你现在的缺口 1 / 缺口 2 形成 **稳定底座** ，确保后面升级不是在松地基上加楼。

---

## P0.1 工具协议定型

你现在已经做了大半，但要明确“定型”。

### 目标

统一一个长期不轻易变的工具契约：

* `name`
* `description`
* `parameters` / JSON Schema
* `validateInput`
* `execute`
* `summarizeOutput`
* `allowedAgents`
* 可选：
  * `requiresHumanApproval`
  * `scopePolicy`
  * `redactionPolicy`
  * `resultVisibility`

### 为什么

后面不管是单 Agent 自主 loop，还是多 Agent 协作，都要依赖这个工具契约。

### 验收标准

* 每个生产工具都能导出结构化 schema
* 所有 tool call 都走同一 runner
* 所有失败都能落统一审计

---

## P0.2 Scope binding / 租户边界统一化

你已经在 consultation 的 `rag.search` 上做了 run scope 注入，这个方向是对的，要推广成 **通用策略** 。

### 目标

任何 LLM 发出的 tool call，都必须满足：

* 模型只能决定“业务允许它决定的字段”
* 不能越权构造业务对象 ID
* graph/runtime 必须把 scope 强制注入

### 应推广到：

* `rag.search`
* `ocr.material_evidence.read`
* `eligibility.rule_engine.check`
* 后续任何文件、审批、外部系统工具

### 建议抽象

给每个工具定义：

* 哪些字段由模型提供
* 哪些字段由 runtime 注入
* 哪些字段必须覆盖模型输入

### 验收标准

* 工具输入中涉及 `application_id / item_id / policy_id / enterprise_id` 的地方，都有 scope binding
* 模型无法通过 tool args 绕过业务 scope

---

## P0.3 失败审计补完整

现在已经有 `agent_tool_calls` failed 记录，但还缺一步： **node 级失败和 loop 级失败的一致审计** 。

### 要补的点

* tool loop 超轮数时：
  * 当前 node 要有 failed step
  * step 中要带已执行 tool refs
  * step 级 token usage 要可追踪
* tool 调用成功但 node 最终失败时：
  * 能从 `agent_run_steps + agent_tool_calls + agent_llm_calls` 完整回放

### 验收标准

* 任意失败 run，都能从数据库还原：
  * 失败在哪个 node
  * 失败前调用了哪些工具
  * 每轮 LLM 用了多少 token
  * 为什么进入 fallback / failed / interrupted

---

## P0.4 工具结果可见性 / 脱敏策略

这是你后面一定会碰到的。

### 目标

明确每种工具结果：

* 哪些字段能进 prompt
* 哪些只能进 state
* 哪些只能进 DB 审计
* 哪些必须脱敏 / 摘要化

### 当前最典型例子

* OCR fields
* RAG citations 原文
* eligibility 原始 evidence
* 后续文件内容、审批意见、外部系统结果

### 验收标准

* 每个工具都有结果可见性规则
* review / application / consultation 各链路不再临时写 if/else 裁剪字段

---

## P0 阶段结束标志

如果满足以下条件，P0 可以收口：

* 所有工具协议统一
* scope binding 统一
* 审计和失败链路完整
* 结果脱敏规则明确
* 当前 consultation / application / review 的工具调用都稳定

---

# P1：从“局部 tool loop”升级到“单 Agent 全局自主 loop”

> 目标：不再只是某个 node 会调工具，而是 agent 能自己决定下一步动作。

---

## P1.1 定义统一 action schema

这是全局自主 loop 的第一步。

你不能只有 `tool_call`，还要让 agent 有“动作空间”。

### 建议最小 action 集

至少包含：

* `call_tool`
* `respond_final`
* `request_human`
* `continue_reasoning`
* `stop_with_manual_review`

后面再扩：

* `delegate_subagent`
* `update_plan`
* `switch_phase`

### 为什么

否则模型只能在“调工具 / 不调工具”之间选，不是真正的 agent。

---

## P1.2 抽象统一 runtime loop

把现在 consultation 里的局部 `runAgentToolLoop` 推广成通用 runtime。

### 当前形态

你现在更像：

```text
graph node
  -> callJsonAgent
    -> 如果允许 tools，跑 tool loop
  -> validate JSON
  -> recordStep
```

### 要升级成

更像：

```text
while not done:
  runtime 读取当前全局 state
  让 agent 输出 action
  runtime 执行动作
  写回 state / steps / audit
  判断是否完成 / fallback / interrupt
```

### 关键变化

“下一步做什么”从 graph 转移到 runtime。

---

## P1.3 graph 从主流程变成阶段护栏

不要一下删 graph，而是先让它降级。

### 现在 graph 的职责

* 决定流程顺序
* 决定何时 fallback
* 决定下游节点

### 未来 graph 的职责

* 限定 phase
* 限定该 phase 可用工具
* 限定该 phase 可执行动作
* 定义强约束（比如必须人工确认）

也就是：

> graph 不再是“导演”，变成“边界管理员”。

---

## P1.4 统一停止条件

全局 loop 里最危险的问题不是“不会做”，而是“不会停”。

### 必须明确

* 什么叫 done
* 什么叫 insufficient info
* 什么叫 manual review
* 什么叫 retry exhausted
* 什么叫 hard failure

### 建议先写成状态枚举

* `completed`
* `manual_review`
* `interrupted`
* `failed`
* `blocked_waiting_human`

---

## P1 阶段结束标志

如果满足以下条件，说明你已从局部 tool call 进入单 Agent 全局 loop：

* consultation 链路可不依赖固定 node 顺序完成主要任务
* agent 能自己决定“继续检索 / 结束 / 转人工”
* graph 只做阶段约束，不再决定每一步
* loop 级停止条件、预算、失败审计稳定

---

# P2：把全局自主 loop 扩到业务主链路

> 目标：不只是 consultation，自主 loop 开始覆盖 application / review 等链路。

---

## P2.1 先扩 consultation，再扩 application，再扩 review

顺序非常重要。

### 推荐顺序

1. **consultation**
   * 风险最低
   * 无写操作
   * 最适合练 runtime
2. **application**
   * 有 OCR / eligibility / fallback
   * 但仍偏“事实收集 + 辅助判断”
3. **review**
   * 风险最高
   * 涉及审核意见、人工处理、权限边界更复杂

### 不建议

一上来把 review 也完全自主化，风险太大。

---

## P2.2 side-effect 工具审批模型

当 agent 不只是查，还开始“做”时，这个必须落地。

### 工具要分类

#### 只读工具

* RAG 检索
* OCR 读取
* eligibility 计算
* 文件读取

#### 可写但可逆

* 草稿写入
* comment 草案
* state scratchpad

#### 不可逆 / 高风险

* 发起审批
* 真正 adopt/reject
* 外部系统写入
* 发消息 / 推送 / 通知

### 要求

* 高风险工具默认不能自动执行
* 必须有 human approval gate
* 审批 decision 要审计

---

## P2.3 context management / memory / scratchpad

全局自主 loop 一旦变长，就会撞到上下文管理。

### 你要尽早决定

* agent 是否有 scratchpad
* scratchpad 存哪里
* 什么进 prompt、什么只进 DB
* 何时裁剪旧 tool result
* 是否支持 resume 后继续 reasoning

### 推荐

先做 **本地 scratchpad + 结构化 state** ，不要一开始就做泛化长期 memory。

---

## P2.4 成本与预算控制

全局 loop 一旦进入 application/review，token 成本和错误成本都会上升。

### 至少要有

* 单 run token budget
* 单 run cost budget
* 单 node max turns
* 单工具 max calls
* 超预算降级策略
* 高成本模型路由策略

---

## P2 阶段结束标志

如果满足以下条件，说明你已经有“可生产试运行”的单 Agent 自主系统：

* consultation/application 至少一条主链路由统一 runtime 驱动
* side-effect 工具有审批门
* 成本 / 超时 / fallback / resume 都可控
* review 仍可保留部分 graph 护栏

---

# P3：进入多 Agent 协作

> 目标：从“一个 Agent 会自己做事”，升级到“多个 Agent 分工合作”。

---

## P3.1 先定义角色，而不是先写并发

这是很多团队会踩的坑。

### 推荐角色

按你当前项目，天然可拆成：

* **Coordinator**
  * 读任务，拆子任务，汇总结果
* **Retriever**
  * 检索政策、知识块、规则引用
* **DocumentVision**
  * OCR / 材料摘要 / 低置信标记
* **EligibilityAnalyst**
  * 跑规则、整理资格证据
* **RiskJudge**
  * 判断是否足够可信、是否需人工
* **ReviewDrafter**
  * 生成审核意见草稿

### 原则

先做 **角色分工清晰** ，再做并发，不要一开始就“大家都能干所有事”。

---

## P3.2 定义 agent-to-agent 协议

多 Agent 真正难的是协议，不是开几个进程。

### 至少要定义

* 子任务输入 schema
* 子任务输出 schema
* 错误返回 schema
* 置信度字段
* 引用 / evidence 格式
* 是否允许继续追问父代理

### 否则会出的问题

* 子代理返回格式不稳定
* 协调者无法自动聚合
* 多代理之间互相污染上下文

---

## P3.3 子代理权限隔离

每个 agent 不能拿全量工具。

### 例子

* Retriever 不能写审核结论
* ReviewDrafter 不能直接调外部审批系统
* DocumentVision 不应该能操作 fallback task
* Coordinator 不一定需要 full OCR fields

### 实现建议

每个 agent:

* 独立 allowed tools
* 独立 scope policy
* 独立 token budget
* 独立 result visibility

---

## P3.4 结果验证层

多 Agent 协作里，**验证层**很关键。

### 推荐加一个 verifier/judge 层

用于：

* 判断子代理输出是否完整
* 判断引用是否足够
* 判断是否需要再召回其他 agent
* 判断冲突结果如何裁决

否则多 Agent 很容易变成“多人一起把错放大”。

---

## P3.5 并发策略

多 Agent 协作不等于永远并发。

### 推荐

#### 可并发

* 多源检索
* 多材料 OCR 摘要
* 多政策对比

#### 不宜并发

* 最终裁决
* 有共享状态写入
* 人工审批前的动作

### 先做

“可控 fan-out + 可控 fan-in”，不要上来做完全自由协作。

---

## P3 阶段结束标志

如果满足以下条件，说明你进入了真正的多 Agent 协作：

* 有 coordinator
* 有至少 2~3 个职责分离的 worker agents
* 有子任务输入输出协议
* 有结果验证 / 汇总层
* 有 agent 级权限隔离和预算
* 并发路径受控可观测

---

# P4：企业级生产化收口

> 目标：让系统不是“能跑”，而是“长期可运营”。

---

## P4.1 观测与回放

必须能回答：

* 这个 run 花了多少 token / 成本？
* 哪个 agent 做了什么？
* 哪个工具失败了？
* 为什么 fallback？
* 哪一步进入人工？
* 能不能完整回放？

### 建议统一看板

* run
* step
* llm_call
* tool_call
* fallback_task
* approval event
* subagent task

---

## P4.2 稳定性与熔断

### 要有

* provider 熔断
* 工具熔断
* 降级模型路由
* 自动切回 legacy path
* 高风险路径 kill switch

---

## P4.3 安全与合规

### 要补

* 工具输入脱敏
* tool result redaction
* PII 最小化
* prompt 注入防护
* side-effect 审批日志
* 租户级隔离审计

---

## P4.4 运维能力

### 要有

* replay run
* force interrupt
* force resume
* override tool permission
* 手动注入 fallback resolution
* 版本回滚（prompt / tool schema / model route）

---

# 四、给你一个实际可执行的里程碑顺序

下面这个顺序最适合你现在的项目。

---

## 里程碑 M1：缺口 1 + 缺口 2 收口

你现在基本已经在这里了。

**完成标志：**

* 通用 Tool Runner 稳定
* consultation 原生 `rag.search` loop 稳定
* scope / fallback / 权限 / 回归测试齐全

---

## 里程碑 M2：统一单 Agent runtime loop

**建议下一步主攻这个。**

### 交付物

* 通用 `agent runtime loop`
* action schema
* loop-level budget / stop condition
* step / tool / llm usage 聚合
* graph 降级成 phase guard

### 先只落 consultation

不要同时碰 application/review

---

## 里程碑 M3：application 接入统一 runtime

### 交付物

* `application_assist` / `document_vision` 接入统一 loop
* OCR / eligibility / fallback 统一动作化
* 人工补件 / fallback 进入同一 runtime 语义

---

## 里程碑 M4：review 半自主化

### 交付物

* review 不再全靠固定 graph
* 但高风险动作仍需人工 gate
* 审核草稿生成由 runtime 驱动
* 真正 adopt / reject 仍保留硬审批

---

## 里程碑 M5：多 Agent coordinator

### 交付物

* coordinator + worker schema
* retriever / document_vision / risk_judge 分工
* fan-out / fan-in 协议
* verifier 层

---

## 里程碑 M6：企业级治理

### 交付物

* 回放
* 熔断
* 成本治理
* 审批门
* 统一可观测性
* 运维控制台

---

# 五、你后续怎么给 Codex 下任务最有效

不要说：

> “实现真正的多 Agent 协作”

这个太大，会发散。

建议你以后按里程碑这样下：

---

## 示例 1：做 M2

> 目标：把 consultation 从“局部 retrieval_planner tool loop”升级为“统一单 Agent runtime loop”，但仍限制只在 consultation 域内，不扩到 application/review。
>
> 范围：设计统一 action schema、stop condition、loop budget、step/token 聚合，并保留现有 fallback 和 policy scope 约束。
>
> 不做：多 Agent 协作、不做 side-effect 工具自动执行。
>
> 输出：先给方案，再落代码和回归测试。

---

## 示例 2：做 M5

> 目标：在 consultation 域内引入 coordinator + retriever + verifier 的最小多 Agent 协作闭环。
>
> 范围：子任务输入输出 schema、agent 权限隔离、聚合和验证逻辑。
>
> 不做：application/review 域迁移，不做全局并发 fan-out。
>
> 输出：先给分工设计、失败场景和验证方案，再实现。

---

# 六、最后给你的最终判断

## 你的问题本质上是：

> “我现在是不是继续补缺口，就能自然长成真正的多 Agent 协作系统？”

我的判断是：

> **可以长过去，但不是自然长成，而是要经历一次明确的架构跃迁。**

更准确地说：

* **缺口 1、缺口 2** 是底座
* **M2** 才是从“局部自治”到“全局自治”的分水岭
* **M5** 才是从“单 Agent 自主”到“多 Agent 协作”的分水岭

所以你的路线应该是：

```text
当前状态
-> 统一单 Agent runtime loop
-> application/review 接入
-> coordinator + worker 多 Agent 协作
-> 企业级治理与生产化
```

---

如果你愿意，我下一条可以直接继续给你输出一份：

## 《多 Agent 协作实施蓝图》

按你项目写成：

* 模块拆分
* 数据结构
* runtime 组件
* agent 角色表
* 每个阶段要改哪些文件
* 每个阶段验收测试清单

你后面就可以直接拿这个蓝图分 batch 让 Codex 干。
