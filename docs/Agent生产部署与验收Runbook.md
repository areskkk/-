# Agent 生产部署与验收 Runbook

## 部署拓扑

- API Web：只处理业务 HTTP、创建 Agent Run、查询状态，不在生产中自动执行长图。
- Agent Worker：独立部署，消费 `agent_run_jobs`，可水平扩容，必须配置唯一 `AGENT_RUN_WORKER_ID`。
- RAG Sidecar：独立部署，生产必须启用内部 API Key，禁止 `haystack_inmemory`。
- OCR Sidecar：独立部署，供 OCR Tool 调用，失败或低置信必须进入 Agent Judge 或 fallback。

## 生产必设环境变量

```bash
NODE_ENV=production
AGENT_RUN_ASYNC_ENABLED=true
AGENT_RUN_WORKER_AUTOSTART=false
AGENT_ORCHESTRATION_ENABLED=true
APPLICATION_AGENT_ENABLED=true
REVIEW_AGENT_ENABLED=true
RAG_SIDECAR_ENABLED=true
AGENT_MODEL_CIRCUIT_BREAKER_ENABLED=true
RAG_REQUIRE_PERSISTENT_BACKEND=true
RAG_BACKEND_MODE=haystack_pgvector
RAG_SERVICE_INTERNAL_API_KEY=<secret-from-vault>
APP_DATABASE_URL=<readonly-postgres-url-for-rag-sidecar>
OCR_PROVIDER=aliyun_cloud_market
OCR_ALIYUN_MARKET_APPID=112343563
OCR_ALIYUN_MARKET_APPNAME=云市场1350670480
OCR_ALIYUN_MARKET_ENDPOINT=<aliyun-cloud-market-ocr-endpoint>
OCR_ALIYUN_MARKET_APPCODE=<secret-from-vault>
OCR_SERVICE_INTERNAL_API_KEY=<secret-from-vault-if-using-ocr-sidecar>
OCR_MAX_FILE_BYTES=10485760
AGENT_RUN_STALE_RUNNING_MS=60000 # must be greater than OCR_SERVICE_TIMEOUT_MS
BAILIAN_API_KEY=<secret-from-vault>
```

`APP_DATABASE_URL` 必须使用只读数据库用户。部署验收时用该账号执行写入业务表 SQL，必须失败；允许读取 `policies`、`policy_chunks`、`policy_ai_whitelist` 及必要只读视图。

## 发布顺序

1. 先跑数据库 migration。
2. 部署 RAG/OCR sidecar，并确认 `/health/live` 与 `/health/ready`。
3. 部署 API Web，保持 worker autostart 关闭。
4. 部署 Agent Worker。
5. 运行 fake eval、live Bailian smoke、RAG heavy suite。
6. 小流量灰度打开业务入口开关。

## Drain 与 Rolling Update

- Worker 收到停止信号后进入 drain：停止 claim 新 job，等待当前 job 完成或 lease 超时恢复。
- 滚动更新前检查 `/api/v1/admin/agent-metrics` 中 `queue_depth.running` 和 `queue_depth.stale`。
- 如果需要快速回滚，先关闭 `AGENT_ORCHESTRATION_ENABLED`、`APPLICATION_AGENT_ENABLED`、`REVIEW_AGENT_ENABLED`，未完成 run 保持 queued/interrupted 或进入人工 fallback，不删除审计记录。

## 告警阈值

- queued job 数持续 10 分钟高于 worker 副本数的 5 倍。
- stale job 数大于 0 持续 5 分钟。
- run failed rate 15 分钟窗口超过 5%。
- interrupted rate 15 分钟窗口超过 20%。
- resume failed count 15 分钟窗口大于 0。
- 任一模型 error_rate 超过 20% 或 circuit_open_until 非空。
- LLM estimated cost 达到日预算 80%。
- fallback SLA overdue_count 大于 0。
- RAG ready 非 200 或 degraded rate 超过 10%。
- OCR failure rate 超过 5%。

## 预发验收命令

```bash
npm run build
npm test
npm run test:rag-heavy
npm run llm:agent-core-eval
npm run llm:bailian-smoke
```

验收结果必须保存到发布记录。没有真实 `BAILIAN_API_KEY`、RAG 只读 DB、sidecar ready 和 eval 通过记录时，只能判定为“后端接近生产可试点”，不能宣称完整企业生产级。
