export type SupportedOcrMaterialType =
  | 'business_license'
  | 'financial_report'
  | 'employment_proof'
  | 'contract'
  | 'other';

export type OcrPageResult = {
  page_no: number;
  text: string;
  image_quality?: string;
};

export type OcrAnalyzeResult = {
  material_type: SupportedOcrMaterialType;
  fields: Record<string, unknown>;
  field_confidence: Record<string, number>;
  overall_confidence: number;
  warnings: string[];
  pages?: OcrPageResult[];
  raw_provider_meta?: Record<string, unknown>;
};

export type OcrProviderAnalyzeInput = {
  material_type: SupportedOcrMaterialType;
  file_path: string;
  file_base64?: string;
  file_url?: string;
  mime_type: string;
  original_filename: string;
};
