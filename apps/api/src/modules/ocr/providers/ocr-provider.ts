import { type OcrAnalyzeResult, type OcrProviderAnalyzeInput } from './ocr.types.js';

export type OcrProvider = {
  analyze(input: OcrProviderAnalyzeInput): Promise<OcrAnalyzeResult>;
};
