# OCR 识别字段定义

> 用途：定义 `ocrAnalyze`、材料校验、资格预判、审核比对所需的字段级 JSON Schema。  
> 口径：字段置信度 `< 0.85` 默认进入人工确认；OCR 结果只作为证据输入，不替代人工审批。

## 1. 通用返回结构

```json
{
  "material_type": "business_license",
  "fields": {},
  "field_confidence": {},
  "overall_confidence": 0.92,
  "pages": [
    {
      "page_no": 1,
      "text": "识别全文摘要",
      "image_quality": "clear"
    }
  ],
  "warnings": []
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| material_type | enum | business_license、financial_report、employment_proof、contract、other |
| fields | object | 按材料类型返回字段 |
| field_confidence | object | 每个字段置信度，0-1 |
| overall_confidence | number | 总体置信度 |
| pages | array | 页级识别信息 |
| warnings | array | 模糊、缺页、字段冲突、疑似过期等提示 |

## 2. 营业执照 business_license

```json
{
  "enterprise_name": "南康某家具有限公司",
  "credit_code": "913607XX0000000000",
  "legal_person": "张三",
  "registered_address": "江西省赣州市南康区...",
  "business_scope": "家具制造；家具销售；货物进出口...",
  "registered_capital": 5000000,
  "established_date": "2020-01-01",
  "valid_period": {
    "start_date": "2020-01-01",
    "end_date": null,
    "long_term": true
  },
  "registration_authority": "赣州市南康区市场监督管理局"
}
```

必识别字段：`enterprise_name`、`credit_code`、`legal_person`、`registered_address`、`business_scope`、`valid_period`。

## 3. 财务报表 financial_report

```json
{
  "enterprise_name": "南康某家具有限公司",
  "report_year": 2025,
  "report_period": "annual",
  "revenue_amount": 12000000,
  "net_profit": 860000,
  "total_assets": 30000000,
  "tax_amount": 900000,
  "currency": "CNY",
  "audit_firm": "某会计师事务所"
}
```

必识别字段：`enterprise_name`、`report_year`、`revenue_amount`。  
P1 字段：`net_profit`、`total_assets`、`tax_amount`、`audit_firm`。

## 4. 用工证明 employment_proof

```json
{
  "enterprise_name": "南康某家具有限公司",
  "employee_count": 86,
  "social_security_count": 80,
  "proof_period": {
    "start_date": "2025-01-01",
    "end_date": "2025-12-31"
  },
  "issuer": "企业或主管机构",
  "issue_date": "2026-01-10"
}
```

必识别字段：`enterprise_name`、`employee_count`、`proof_period`、`issue_date`。  
若 `employee_count` 与企业画像差异较大，进入人工确认。

## 5. 合同 contract

```json
{
  "contract_name": "家具出口销售合同",
  "party_a": "南康某家具有限公司",
  "party_b": "某采购方",
  "contract_amount": 2000000,
  "currency": "CNY",
  "signed_date": "2025-09-01",
  "effective_date": "2025-09-01",
  "expire_date": "2026-09-01",
  "contract_subject": "家具产品采购",
  "is_export_related": true
}
```

必识别字段：`party_a`、`party_b`、`contract_amount`、`signed_date`、`contract_subject`。  
出口相关判断只能作为线索，需结合政策要求和人工核验。

## 6. 字段置信度要求

| 场景 | 规则 |
| --- | --- |
| 字段置信度 >= 0.85 | 可进入规则比对 |
| 字段置信度 < 0.85 | 标记 `low_confidence`，进入人工确认 |
| 企业名称与画像不一致 | 转人工确认 |
| 统一社会信用代码格式错误 | 企业绑定不得自动通过 |
| 材料疑似过期 | 提示重新上传或人工确认 |
| 材料类型识别不确定 | 不进入硬规则判断 |

## 7. ocrAnalyze 返回 Schema

```json
{
  "type": "object",
  "required": ["material_type", "fields", "field_confidence", "overall_confidence", "warnings"],
  "properties": {
    "material_type": {
      "type": "string",
      "enum": ["business_license", "financial_report", "employment_proof", "contract", "other"]
    },
    "fields": {
      "type": "object"
    },
    "field_confidence": {
      "type": "object",
      "additionalProperties": {
        "type": "number",
        "minimum": 0,
        "maximum": 1
      }
    },
    "overall_confidence": {
      "type": "number",
      "minimum": 0,
      "maximum": 1
    },
    "warnings": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  }
}
```
