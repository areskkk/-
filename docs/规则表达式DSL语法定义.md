# 规则表达式 DSL 语法定义

> 用途：定义 `PolicyCondition` 的可执行表达方式，供资格预判、政策结构化、审核比对使用。  
> 口径：AI 可生成规则草稿，但必须由政策管理员审核发布后进入规则库。

## 1. 条件对象

```json
{
  "condition_id": "cond_001",
  "field_key": "enterprise_profile.industry",
  "operator": "in",
  "target_value": ["家具制造", "木材加工"],
  "required": true,
  "evidence_type": "profile",
  "fail_action": "ineligible",
  "message": "企业所属行业需为家具制造或木材加工。"
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| condition_id | string | 是 | 条件 ID |
| field_key | string | 是 | 字段路径 |
| operator | enum | 是 | 比较符 |
| target_value | any | 是 | 目标值 |
| required | boolean | 是 | 是否硬性条件 |
| evidence_type | enum | 是 | profile、material、ocr、manual |
| fail_action | enum | 是 | ineligible、need_info、manual_review |
| message | string | 是 | 给企业或审核人员看的说明 |

字段路径必须来自 `docs/字段路径映射表.md`；新增 `field_key` 需先进入字段路径映射表，再进入政策规则草稿。

## 2. 操作符

| operator | 说明 | target_value 示例 |
| --- | --- | --- |
| eq | 等于 | `"家具制造"` |
| neq | 不等于 | `"已废止"` |
| in | 属于集合 | `["家具制造", "木材加工"]` |
| not_in | 不属于集合 | `["失信企业"]` |
| gte | 大于等于 | `5000000` |
| lte | 小于等于 | `20000000` |
| between | 区间 | `{ "min": 5000000, "max": 20000000 }` |
| exists | 字段存在 | `true` |
| contains | 文本包含 | `"技改"` |

## 3. 组合表达式

### AND

```json
{
  "logic": "AND",
  "conditions": ["cond_industry", "cond_revenue", "cond_material"]
}
```

### OR

```json
{
  "logic": "OR",
  "conditions": ["cond_export", "cond_tech_upgrade"]
}
```

### 嵌套

```json
{
  "logic": "AND",
  "conditions": [
    "cond_industry",
    {
      "logic": "OR",
      "conditions": ["cond_tax", "cond_export"]
    }
  ]
}
```

## 4. 失败动作

| fail_action | 使用场景 | 输出 |
| --- | --- | --- |
| ineligible | 硬性条件明确不满足 | 不符合 |
| need_info | 缺少字段或材料 | 待补充 |
| manual_review | 自由裁量、政策冲突、OCR 低置信度 | 需人工复核 |

## 5. 示例

### 示例 1：行业属于家具制造

```json
{
  "field_key": "enterprise_profile.industry",
  "operator": "in",
  "target_value": ["家具制造", "木材加工"],
  "required": true,
  "evidence_type": "profile",
  "fail_action": "ineligible"
}
```

### 示例 2：年营收不低于 500 万

```json
{
  "field_key": "enterprise_profile.revenue_amount",
  "operator": "gte",
  "target_value": 5000000,
  "required": true,
  "evidence_type": "profile",
  "fail_action": "need_info"
}
```

### 示例 3：必须上传营业执照

```json
{
  "field_key": "materials.business_license.file_id",
  "operator": "exists",
  "target_value": true,
  "required": true,
  "evidence_type": "material",
  "fail_action": "need_info"
}
```

### 示例 4：OCR 识别企业名称一致

```json
{
  "field_key": "ocr.business_license.enterprise_name",
  "operator": "eq",
  "target_value": "$enterprise_profile.enterprise_name",
  "required": true,
  "evidence_type": "ocr",
  "fail_action": "manual_review"
}
```

### 示例 5：满足技改或出口任一条件

```json
{
  "logic": "OR",
  "conditions": [
    {
      "field_key": "enterprise_profile.tech_upgrade_status",
      "operator": "in",
      "target_value": ["in_progress", "completed"],
      "required": false,
      "evidence_type": "profile",
      "fail_action": "need_info"
    },
    {
      "field_key": "enterprise_profile.export_amount",
      "operator": "gte",
      "target_value": 1,
      "required": false,
      "evidence_type": "profile",
      "fail_action": "need_info"
    }
  ]
}
```

## 6. 发布规则

- AI 生成的 DSL 只作为草稿。
- 政策管理员审核后才能发布。
- 已发布规则必须记录 policy_id、version、reviewer_id、published_at。
- 修改规则必须生成新版本。

## 附录 A：字段路径映射

完整字段字典见 `docs/字段路径映射表.md`。规则 DSL 常用字段包括：

| field_key | 说明 |
| --- | --- |
| enterprise_profile.enterprise_name | 企业名称 |
| enterprise_profile.credit_code | 统一社会信用代码 |
| enterprise_profile.region | 注册或经营所在区县 |
| enterprise_profile.industry | 所属行业 |
| enterprise_profile.revenue_amount | 年营业收入 |
| enterprise_profile.tax_amount | 年纳税额 |
| enterprise_profile.employee_count | 员工人数 |
| enterprise_profile.export_amount | 年出口额 |
| enterprise_profile.tech_upgrade_status | 技改状态 |
| materials.business_license.file_id | 营业执照文件 |
| ocr.business_license.enterprise_name | 营业执照 OCR 企业名称 |
| ocr.business_license.credit_code | 营业执照 OCR 统一社会信用代码 |
| ocr.financial_report.revenue_amount | 财报 OCR 营业收入 |
| ocr.employment_proof.employee_count | 用工证明 OCR 员工人数 |
| ocr.contract.contract_amount | 合同 OCR 金额 |
