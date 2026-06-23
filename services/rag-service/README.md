# RAG Service

Batch 9 的独立 Python sidecar，仅负责检索底层能力。

## 范围

- 清洗政策原文
- 结构优先分块
- embedding
- retrieve
- 最小 ingest / search HTTP 接口

## 不负责

- `effective` / `policy_ai_whitelist` 业务最终裁决
- fallback task 创建
- 最终 citation 业务语义
- 正式 LLM 回答生成

## backend mode

- `haystack_inmemory`
- `haystack_pgvector`
- `local_fallback` 仅作为 Node 主服务降级标识，不在 sidecar 内部伪装

### 当前状态

- `haystack_inmemory`：当前可用，已用于本地联调与主链检索
- `haystack_pgvector`：当前仅完成 11A 的代码路径、配置与启动前环境校验准备
- `haystack_pgvector` 在 11A 不代表“已正式接通”，只有在 PostgreSQL 已安装 `vector` 扩展且 `pgvector-haystack` 依赖齐备时，才会进入后续 11B 的正式联调

## 启动

```bash
python -m venv .venv
.venv\\Scripts\\activate
pip install -e .
uvicorn app.main:app --host 0.0.0.0 --port 8001
```

如需准备 pgvector 路径：

```bash
pip install -e .[pgvector]
```

## Embedding 模型来源

- 优先使用 `HAYSTACK_EMBEDDING_MODEL_PATH`
- 如果配置了本地模型目录但目录不存在或不是模型目录，sidecar 会直接启动失败
- 只有未配置 `HAYSTACK_EMBEDDING_MODEL_PATH` 时，才会使用 `HAYSTACK_EMBEDDING_MODEL`

## 可选镜像 / 代理

- `HF_ENDPOINT`
- `HTTP_PROXY`
- `HTTPS_PROXY`

## 数据访问边界

- sidecar 默认只读访问主库事实源
- 当前骨架不写业务事实表
- 如需写入，仅限检索底座相关表，不扩展成第二个业务后端

## pgvector 模式硬校验

当 `RAG_BACKEND_MODE=haystack_pgvector` 时，sidecar 启动前会显式校验：

- `PG_CONN_STR` 是否已配置
- PostgreSQL 是否存在 `vector` 扩展
- `pgvector-haystack` 依赖是否已安装
- `PgvectorDocumentStore` 是否可初始化

任一条件不满足都会直接启动失败，不会静默回退到 `haystack_inmemory`。
