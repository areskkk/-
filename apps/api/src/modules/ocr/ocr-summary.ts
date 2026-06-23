const OCR_LOW_CONFIDENCE_THRESHOLD = 0.85;

type OcrSummaryInput = {
  material_type: string;
  ocr_status: string;
  ocr_result_id?: string | null;
  fields?: Record<string, unknown> | null;
  field_confidence?: Record<string, number> | null;
  overall_confidence?: number | null;
  warnings?: string[] | null;
  requires_manual_confirmation?: boolean | null;
};

type FieldDisplay = {
  field_key: string;
  field_label: string;
  value: unknown;
};

type LowConfidenceField = FieldDisplay & {
  confidence: number;
  message: string;
};

type OverallRisk = {
  is_low_confidence: boolean;
  confidence: number;
  message: string;
} | null;

const FIELD_LABELS: Record<string, Record<string, string>> = {
  business_license: {
    enterprise_name: '企业名称',
    credit_code: '统一社会信用代码',
    legal_person: '法定代表人',
    registered_address: '注册地址',
    business_scope: '经营范围',
    valid_period: '有效期',
  },
};

const ENTERPRISE_SUMMARY_FIELDS: Record<string, string[]> = {
  business_license: [
    'enterprise_name',
    'credit_code',
    'legal_person',
    'registered_address',
  ],
};

function getFieldLabel(materialType: string, fieldKey: string): string {
  return FIELD_LABELS[materialType]?.[fieldKey] ?? fieldKey;
}

function getDisplayMessage(input: {
  ocr_status: string;
  requires_manual_confirmation: boolean;
}): string {
  if (input.ocr_status === 'pending') {
    return '尚未识别';
  }

  if (input.ocr_status === 'failed') {
    return 'OCR 识别失败，请重新上传更清晰材料或联系人工处理';
  }

  if (input.requires_manual_confirmation) {
    return '存在需人工确认的 OCR 字段，当前结果不能直接作为硬证据';
  }

  return 'OCR 已识别，可作为材料核对参考';
}

function buildRecognizedFieldsSummary(input: OcrSummaryInput): FieldDisplay[] {
  const keys = ENTERPRISE_SUMMARY_FIELDS[input.material_type] ?? [];
  const fields = input.fields ?? {};

  return keys
    .filter((fieldKey) => fieldKey in fields)
    .map((fieldKey) => ({
      field_key: fieldKey,
      field_label: getFieldLabel(input.material_type, fieldKey),
      value: fields[fieldKey],
    }));
}

function buildLowConfidenceFields(input: OcrSummaryInput): LowConfidenceField[] {
  const fields = input.fields ?? {};
  const fieldConfidence = input.field_confidence ?? {};

  return Object.entries(fieldConfidence)
    .filter(([, confidence]) => confidence < OCR_LOW_CONFIDENCE_THRESHOLD)
    .map(([fieldKey, confidence]) => ({
      field_key: fieldKey,
      field_label: getFieldLabel(input.material_type, fieldKey),
      value: fields[fieldKey] ?? null,
      confidence,
      message: `${getFieldLabel(input.material_type, fieldKey)} 置信度低于 0.85，需人工确认`,
    }))
    .sort((left, right) => left.confidence - right.confidence);
}

function buildOverallRisk(overallConfidence: number | null | undefined): OverallRisk {
  if (overallConfidence === null || overallConfidence === undefined) {
    return null;
  }

  if (overallConfidence >= OCR_LOW_CONFIDENCE_THRESHOLD) {
    return null;
  }

  return {
    is_low_confidence: true,
    confidence: overallConfidence,
    message: 'OCR 整体置信度低于 0.85，需人工确认',
  };
}

function normalizeWarnings(warnings: string[] | null | undefined): string[] {
  return warnings ?? [];
}

function shouldRequireManualConfirmation(input: OcrSummaryInput): boolean {
  const overallRisk = buildOverallRisk(input.overall_confidence);
  return Boolean(
    input.requires_manual_confirmation
    || buildLowConfidenceFields(input).length > 0
    || overallRisk?.is_low_confidence,
  );
}

export function buildEnterpriseOcrSummary(input: OcrSummaryInput) {
  const lowConfidenceFields = buildLowConfidenceFields(input);
  const overallRisk = buildOverallRisk(input.overall_confidence);
  const requiresManualConfirmation = shouldRequireManualConfirmation(input);

  return {
    status: input.ocr_status,
    display_message: getDisplayMessage({
      ocr_status: input.ocr_status,
      requires_manual_confirmation: requiresManualConfirmation,
    }),
    requires_manual_confirmation: requiresManualConfirmation,
    overall_confidence: input.ocr_status === 'pending' || input.ocr_status === 'failed'
      ? null
      : input.overall_confidence ?? null,
    warnings: normalizeWarnings(input.warnings),
    recognized_fields_summary:
      input.ocr_status === 'pending' || input.ocr_status === 'failed'
        ? []
        : buildRecognizedFieldsSummary(input),
    low_confidence_fields: lowConfidenceFields,
    overall_risk: overallRisk,
  };
}

export function buildGovernmentOcrEvidence(input: OcrSummaryInput) {
  const lowConfidenceFields = buildLowConfidenceFields(input);
  const overallRisk = buildOverallRisk(input.overall_confidence);
  const requiresManualConfirmation = shouldRequireManualConfirmation(input);

  return {
    status: input.ocr_status,
    display_message: getDisplayMessage({
      ocr_status: input.ocr_status,
      requires_manual_confirmation: requiresManualConfirmation,
    }),
    ocr_result_id: input.ocr_result_id ?? null,
    requires_manual_confirmation: requiresManualConfirmation,
    overall_confidence: input.ocr_status === 'pending' || input.ocr_status === 'failed'
      ? null
      : input.overall_confidence ?? null,
    warnings: normalizeWarnings(input.warnings),
    fields: input.ocr_status === 'pending' || input.ocr_status === 'failed'
      ? null
      : input.fields ?? {},
    field_confidence: input.ocr_status === 'pending' || input.ocr_status === 'failed'
      ? null
      : input.field_confidence ?? {},
    low_confidence_fields: lowConfidenceFields,
    overall_risk: overallRisk,
    evidence_notice:
      'OCR 结果仅作证据参考；低置信度字段不得直接作为硬证据通过，最终审核结论仍由人工确认。',
  };
}
