# AGENTS.md

## 回复要求

回复务实、简洁、专注、直接。默认使用中文。

## 项目规则

执行 PRD、竞品分析、市场调研、AB Test、Onboarding、总结、文档处理、语音转写相关任务前，先读取：

- `memory/preferences.md`
- `memory/skill-overrides.md`
- `skills-index.md`

如果任务涉及 PRD，再读取：

- `memory/prd-template.md`

如果任务涉及竞品或市场分析，再读取：

- `memory/competitive-analysis-template.md`
- `memory/research-log.md`

如果任务涉及编码、实现方案或技术文档，必须先读取：

- `memory/team-coding-standards.md`
- `memory/project-structure-standards.md`

并默认遵守其中关于：
- 一个 batch 一个提交面
- 每批结束后先收干净工作区
- 下一批优先建议开启新会话
- 给 Codex 使用短模板提示词
的规则。

如果任务涉及代码审查 / review / security review，必须再额外先读取：

- `memory/code-review-standards.md`
- `memory/team-coding-standards.md`

并默认按“当前 batch / 当前 diff / 当前工作区”做事实审查，不复述全项目长历史。

如果任务还涉及 Agent 架构、模型选型、RAG、AI 系统设计，再继续读取：

- `memory/agent-orchestration-standards.md`
- `memory/model-selection-standards.md`

## Skill 管理

- `skills/*/SKILL.md` 保持原版，不直接修改。
- 项目偏好、团队规范、模板、对 skill 的补充要求，放到 `memory/` 或 `skills-index.md`。
- 手动下载的原始包放到 `archives/`，不要放在 `skills/` 根目录。
- 新增或替换 skill 后，同步更新 `skills-lock.json` 和 `skills-index.md`。
