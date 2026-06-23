import { ApiError } from '../../../common/errors/http-error.js';
import {
  findRoleCodesByUserId,
  findUserById,
} from '../../auth/auth.repository.js';
import { findApprovedEnterprisesByUserId } from '../../enterprises/enterprises.repository.js';
import { listMaterialsByApplicationId } from '../../materials/materials.repository.js';
import { permissionService } from '../../permission/permission.service.js';
import { findReviewTaskByItemId } from '../../review/review.repository.js';
import { findApplicationAgentContext } from '../runtime/application-context.repository.js';
import {
  AgentToolError,
  type AgentToolContext,
  type AgentToolDefinition,
} from './tool.types.js';

const OCR_LOW_CONFIDENCE_THRESHOLD = 0.85;

export type MaterialEvidenceSummary = {
  material_id: string;
  material_type: string;
  ocr_status: string;
  ocr_result_id: string | null;
  overall_confidence: number | null;
  requires_manual_confirmation: boolean;
  hard_evidence_allowed: boolean;
  low_confidence_fields: Array<{
    field: string;
    confidence: number;
  }>;
  warnings: string[];
  fields: Record<string, unknown>;
};

export type MaterialEvidenceReadToolOutput = {
  materials: MaterialEvidenceSummary[];
  low_confidence_material_ids: string[];
  hard_evidence_notice: string;
};

type MaterialEvidenceReadToolInput = {
  application_id: string;
  confirmed_materials: string[];
  mode: 'summary' | 'full';
};

export const materialEvidenceReadTool: AgentToolDefinition<
  MaterialEvidenceReadToolInput,
  MaterialEvidenceReadToolOutput
> = {
  name: 'ocr.material_evidence.read',
  description: 'Read OCR material evidence with low-confidence guardrails.',
  allowedAgents: ['document_vision', 'review', 'application_assist'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['application_id'],
    properties: {
      application_id: {
        type: 'string',
        description: 'Application id whose current material evidence should be read.',
      },
      confirmed_materials: {
        type: 'array',
        items: { type: 'string' },
        description: 'Material ids manually confirmed by a human.',
      },
      mode: {
        type: 'string',
        enum: ['summary', 'full'],
        description: 'summary excludes OCR fields; full includes fields only when allowed.',
      },
    },
  },
  validateInput(input) {
    const value = assertRecord(input);
    return {
      application_id: assertNonEmptyString(value.application_id, 'application_id'),
      confirmed_materials: Array.isArray(value.confirmed_materials)
        ? value.confirmed_materials.filter((item): item is string => typeof item === 'string')
        : [],
      mode: value.mode === 'full' ? 'full' : 'summary',
    };
  },
  async execute(input, context) {
    await assertApplicationAccess(input.application_id, context);
    const confirmedMaterials = new Set(input.confirmed_materials);
    const materials = await listMaterialsByApplicationId(input.application_id);
    const summaries = materials.map((material) => summarizeMaterialEvidence(
      material,
      confirmedMaterials,
      input.mode,
    ));
    return {
      materials: summaries,
      low_confidence_material_ids: summaries
        .filter((material) => !material.hard_evidence_allowed)
        .map((material) => material.material_id),
      hard_evidence_notice:
        'Low confidence OCR is visible to agents but cannot satisfy hard eligibility rules.',
    };
  },
  summarizeOutput(output) {
    return {
      material_count: output.materials.length,
      low_confidence_material_count: output.low_confidence_material_ids.length,
      hard_evidence_allowed_count: output.materials.filter(
        (material) => material.hard_evidence_allowed,
      ).length,
      hard_evidence_guardrail:
        'low confidence OCR fields are excluded from hard evidence',
    };
  },
};

function summarizeMaterialEvidence(material: {
  material_id: string;
  material_type: string;
  ocr_status: string;
  ocr_result_id: string | null;
  ocr_fields: Record<string, unknown> | null;
  field_confidence: Record<string, number> | null;
  overall_confidence: string | null;
  warnings: string[] | null;
  requires_manual_confirmation: boolean | null;
}, confirmedMaterials = new Set<string>(), mode: 'summary' | 'full'): MaterialEvidenceSummary {
  const overallConfidence = numberOrNull(material.overall_confidence);
  const fieldConfidence = material.field_confidence ?? {};
  const lowConfidenceFields = Object.entries(fieldConfidence)
    .filter(([, confidence]) => confidence < OCR_LOW_CONFIDENCE_THRESHOLD)
    .map(([field, confidence]) => ({ field, confidence }));
  const requiresManualConfirmation =
    !confirmedMaterials.has(material.material_id) &&
    (
      material.requires_manual_confirmation === true ||
      material.ocr_status === 'low_confidence' ||
      lowConfidenceFields.length > 0 ||
      (overallConfidence !== null && overallConfidence < OCR_LOW_CONFIDENCE_THRESHOLD)
    );

  return {
    material_id: material.material_id,
    material_type: material.material_type,
    ocr_status: material.ocr_status,
    ocr_result_id: material.ocr_result_id,
    overall_confidence: overallConfidence,
    requires_manual_confirmation: requiresManualConfirmation,
    hard_evidence_allowed:
      material.ocr_status === 'success' && !requiresManualConfirmation,
    low_confidence_fields: lowConfidenceFields,
    warnings: material.warnings ?? [],
    fields: mode === 'full' ? material.ocr_fields ?? {} : {},
  };
}

async function assertApplicationAccess(
  applicationId: string,
  context: AgentToolContext,
): Promise<void> {
  const application = await findApplicationAgentContext(applicationId);
  if (!application) {
    throw new ApiError('NOT_FOUND', 'application not found');
  }
  if (context.entrypoint === 'review') {
    await assertReviewMaterialAccess({
      application_id: applicationId,
      context,
    });
    return;
  }
  const enterprises = await findApprovedEnterprisesByUserId(context.actor_id);
  const matched = enterprises.find(
    (enterprise) => enterprise.enterprise_id === application.enterprise_id,
  );
  if (!matched) {
    throw new ApiError('FORBIDDEN', 'application enterprise access is denied');
  }
}

async function assertReviewMaterialAccess(input: {
  application_id: string;
  context: AgentToolContext;
}): Promise<void> {
  if (!input.context.item_id) {
    throw new ApiError('VALIDATION_ERROR', 'item_id is required for review material evidence read');
  }
  const user = await findUserById(input.context.actor_id);
  const roles = input.context.roles?.length
    ? input.context.roles
    : await findRoleCodesByUserId(input.context.actor_id);
  const allowed = await permissionService.can({
    actor_id: input.context.actor_id,
    roles,
    user_type: input.context.user_type ?? user?.user_type,
    action: 'review.tasks.decision',
    resource: 'review.tasks',
  });
  if (!allowed) {
    throw new ApiError('FORBIDDEN', 'Review permission is required');
  }
  const task = await findReviewTaskByItemId(input.context.item_id);
  if (!task) {
    throw new ApiError('NOT_FOUND', 'review task not found');
  }
  if (task.application_id !== input.application_id) {
    throw new ApiError('FORBIDDEN', 'review task application mismatch');
  }
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentToolError({
      type: 'invalid_input',
      message: 'tool input must be an object',
    });
  }
  return value as Record<string, unknown>;
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgentToolError({
      type: 'invalid_input',
      message: `${field} is required`,
    });
  }
  return value.trim();
}

function numberOrNull(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
