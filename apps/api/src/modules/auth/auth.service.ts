import bcrypt from 'bcryptjs';
import { ApiError } from '../../common/errors/http-error.js';
import { query } from '../../db/query.js';
import {
  assignRole,
  findRoleCodesByUserId,
  findUserById,
  findUserByPhone,
  insertUser,
  updateUserPasswordHash,
} from './auth.repository.js';
import { type LoginRequest, type RegisterRequest, type ResetPasswordRequest } from './auth.types.js';

type EnterpriseBindingSummary = {
  enterprise_id: string;
  name: string;
  credit_code: string;
  status: string;
  role: string;
  auth_status: string;
};

const registerRoleProfiles: Record<string, { userType: string; roleCode: string }> = {
  enterprise: { userType: 'enterprise', roleCode: 'viewer' },
  government_reviewer: { userType: 'government', roleCode: 'reviewer' },
  platform_admin: { userType: 'admin', roleCode: 'system_admin' },
  policy_admin: { userType: 'admin', roleCode: 'policy_admin' },
};

export class AuthService {
  async register(input: RegisterRequest) {
    if (!input.name || !input.phone || !input.password) {
      throw new ApiError('VALIDATION_ERROR', 'name, phone and password are required');
    }

    const existing = await findUserByPhone(input.phone);
    if (existing) {
      throw new ApiError('CONFLICT', 'phone is already registered');
    }

    const roleProfile = this.resolveRegisterRole(input);
    const passwordHash = await bcrypt.hash(input.password, 10);
    const user = await insertUser({
      name: input.name,
      phone: input.phone,
      password_hash: passwordHash,
      user_type: roleProfile.userType,
    });

    await assignRole(user.user_id, roleProfile.roleCode);
    const roles = await findRoleCodesByUserId(user.user_id);

    return {
      user_id: user.user_id,
      name: user.name,
      phone: user.phone,
      user_type: user.user_type,
      roles,
    };
  }

  private resolveRegisterRole(input: RegisterRequest): { userType: string; roleCode: string } {
    if (input.role_code) {
      const roleProfile = registerRoleProfiles[input.role_code];
      if (!roleProfile) {
        throw new ApiError('VALIDATION_ERROR', 'unsupported register role');
      }
      return roleProfile;
    }

    if (input.user_type === 'government') {
      return registerRoleProfiles.government_reviewer;
    }
    if (input.user_type === 'admin') {
      return registerRoleProfiles.platform_admin;
    }
    return registerRoleProfiles.enterprise;
  }

  async login(input: LoginRequest) {
    if (!input.phone || !input.password) {
      throw new ApiError('VALIDATION_ERROR', 'phone and password are required');
    }

    const user = await findUserByPhone(input.phone);
    if (!user?.password_hash) {
      throw new ApiError('AUTH_REQUIRED', 'invalid phone or password');
    }

    const matched = await bcrypt.compare(input.password, user.password_hash);
    if (!matched) {
      throw new ApiError('AUTH_REQUIRED', 'invalid phone or password');
    }

    const roles = await findRoleCodesByUserId(user.user_id);
    return {
      user_id: user.user_id,
      name: user.name,
      phone: user.phone,
      user_type: user.user_type,
      roles,
    };
  }

  async resetPassword(input: ResetPasswordRequest) {
    if (!input.phone || !input.password) {
      throw new ApiError('VALIDATION_ERROR', 'phone and password are required');
    }

    const user = await findUserByPhone(input.phone);
    if (!user) {
      throw new ApiError('AUTH_REQUIRED', 'user does not exist');
    }
    if (user.status !== 'active') {
      throw new ApiError('FORBIDDEN', 'account is disabled');
    }

    const passwordHash = await bcrypt.hash(input.password, 10);
    await updateUserPasswordHash({
      user_id: user.user_id,
      password_hash: passwordHash,
    });

    return {
      user_id: user.user_id,
      phone: user.phone,
      password_reset: true,
    };
  }

  async getCurrentUser(userId: string) {
    const user = await findUserById(userId);
    if (!user) {
      throw new ApiError('AUTH_REQUIRED', 'user does not exist');
    }
    if (user.status !== 'active') {
      throw new ApiError('FORBIDDEN', 'account is disabled');
    }

    const [roles, enterpriseBindings] = await Promise.all([
      findRoleCodesByUserId(user.user_id),
      this.listEnterpriseBindings(user.user_id),
    ]);

    return {
      user_id: user.user_id,
      name: user.name,
      phone: user.phone,
      user_type: user.user_type,
      status: user.status,
      roles,
      enterprise_bindings: enterpriseBindings,
      has_bound_enterprise: enterpriseBindings.some((binding) => (
        binding.auth_status === 'agent_approved' ||
        binding.auth_status === 'manual_approved'
      )),
      created_at: user.created_at?.toISOString(),
    };
  }

  private async listEnterpriseBindings(userId: string): Promise<EnterpriseBindingSummary[]> {
    return query<EnterpriseBindingSummary>(
      `
        SELECT
          e.enterprise_id::text,
          e.name,
          e.credit_code,
          e.status::text,
          ea.role::text,
          ea.auth_status::text
        FROM enterprise_accounts ea
        INNER JOIN enterprises e ON e.enterprise_id = ea.enterprise_id
        WHERE ea.user_id = $1
        ORDER BY ea.created_at DESC
      `,
      [userId],
    );
  }
}

export const authService = new AuthService();
