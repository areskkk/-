import { ApiError } from '../../common/errors/http-error.js';
import { auditService } from '../audit/audit.service.js';
import { findApprovedEnterprisesByUserId } from '../enterprises/enterprises.repository.js';
import {
  getCurrentProfileByEnterpriseId,
  upsertCurrentProfile,
} from './enterprise-profile.repository.js';

export type EnterpriseProfilePayload = {
  enterprise_id: string;
  enterprise_name: string;
  credit_code: string;
  industry?: string;
  scale?: string;
  revenue_amount?: number;
  employee_count?: number;
  tax_amount?: number;
  export_amount?: number;
  tech_upgrade_status?: string;
  profile_json?: Record<string, unknown>;
};

async function resolveOwnedEnterpriseId(actorId: string, enterpriseId?: string): Promise<string> {
  const enterprises = await findApprovedEnterprisesByUserId(actorId);
  if (enterprises.length === 0) {
    throw new ApiError('FORBIDDEN', 'current user is not bound to any enterprise');
  }

  if (!enterpriseId) {
    return enterprises[0].enterprise_id;
  }

  const matched = enterprises.find((enterprise) => enterprise.enterprise_id === enterpriseId);
  if (!matched) {
    throw new ApiError('FORBIDDEN', 'enterprise access is denied');
  }

  return matched.enterprise_id;
}

export class EnterpriseProfileService {
  async getCurrentProfile(actorId: string, enterpriseId?: string) {
    const resolvedEnterpriseId = await resolveOwnedEnterpriseId(actorId, enterpriseId);
    const profile = await getCurrentProfileByEnterpriseId(resolvedEnterpriseId);
    return {
      current_profile: profile ?? null,
      snapshot_status:
        'Enterprise profile snapshots are reserved for application submit flow and are not generated in Batch 2.',
    };
  }

  async upsertCurrentProfile(
    actorId: string,
    traceId: string,
    input: EnterpriseProfilePayload,
  ) {
    const resolvedEnterpriseId = await resolveOwnedEnterpriseId(actorId, input.enterprise_id);
    const profile = await upsertCurrentProfile({
      ...input,
      enterprise_id: resolvedEnterpriseId,
      source: 'manual',
    });

    await auditService.write({
      actor_id: actorId,
      action: 'enterprise_profile.upsert',
      target_type: 'enterprise_profile',
      target_id: profile.profile_id,
      trace_id: traceId,
      detail: {
        enterprise_id: profile.enterprise_id,
      },
    });

    return {
      current_profile: profile,
      snapshot_status:
        'Current profile only. Snapshot freezing is reserved for future application submit flow.',
    };
  }
}

export const enterpriseProfileService = new EnterpriseProfileService();
