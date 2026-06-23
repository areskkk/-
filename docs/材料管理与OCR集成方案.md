# 材料管理与 OCR 集成方案

## 1. 范围

MVP 材料只绑定本次申报，不建设企业长期材料库，不跨历史事项复用。

字段级 OCR Schema 见 `docs/OCR识别字段定义.md`；规则字段路径见 `docs/字段路径映射表.md`。

## 2. 材料类型

| 类型 | 示例字段 | OCR 要求 |
| --- | --- | --- |
| business_license | 企业名称、统一社会信用代码、注册地址 | 必做 |
| financial_report | 年度、营收、利润 | P1 |
| employment_proof | 人数、日期、单位 | P1 |
| contract | 合同主体、金额、日期 | P1 |
| other | 自定义 | 按政策配置 |

## 2.1 OCR 字段级要求

| 材料类型 | 必识别字段 | 低置信度处理 |
| --- | --- | --- |
| business_license | enterprise_name、credit_code、legal_person、registered_address、business_scope、valid_period | 任一关键字段 < 0.85 转人工确认 |
| financial_report | enterprise_name、report_year、revenue_amount | revenue_amount 缺失或 < 0.85 时不得用于硬规则通过 |
| employment_proof | enterprise_name、employee_count、proof_period、issue_date | employee_count < 0.85 或与画像差异大时转人工 |
| contract | party_a、party_b、contract_amount、signed_date、contract_subject | 金额、主体、日期任一低置信度转人工 |
| other | 按政策配置 | 默认转人工确认 |

## 3. OCR 流程

1. 企业上传材料。
2. 系统生成文件 hash。
3. OCR 识别材料类型和字段。
4. 字段置信度 >= 0.85 可进入规则比对。
5. 字段置信度 < 0.85 标记人工确认。
6. OCR 结果写入材料记录和审计 trace。

ocrAnalyze 返回结构必须符合 `docs/OCR识别字段定义.md` 第 7 节 Schema。

## 4. 本次申报内复用

- 同一申报内多个政策需要同一材料时，只上传一次。
- 通过 material_type 和 hash 判断可复用。
- 拆分政策子项后，各子项引用同一个 material_id。

## 5. 异常处理

| 场景 | 处理 |
| --- | --- |
| OCR 失败 | 允许人工录入关键字段 |
| 材料过期 | 提示重新上传 |
| 材料类型不匹配 | 阻止提交或转人工 |
| 手机端上传失败 | 保留草稿，支持重试 |
