import { type FastifyInstance } from 'fastify';
import { registerAdminRoutes } from './modules/admin/admin.routes.js';
import { registerAgentRoutes } from './modules/agents/agents.routes.js';
import { registerApplicationRoutes } from './modules/applications/applications.routes.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { registerEligibilityRoutes } from './modules/eligibility/eligibility.routes.js';
import { registerEnterpriseProfileRoutes } from './modules/enterprise-profile/enterprise-profile.routes.js';
import { registerEnterpriseRoutes } from './modules/enterprises/enterprises.routes.js';
import { registerFileRoutes } from './modules/files/files.routes.js';
import { registerFrontendRoutes } from './modules/frontend/frontend.routes.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';
import { registerMaterialRoutes } from './modules/materials/materials.routes.js';
import { registerOcrRoutes } from './modules/ocr/ocr.routes.js';
import { registerPolicyQaRoutes } from './modules/policy-qa/policy-qa.routes.js';
import { registerPolicyRoutes } from './modules/policies/policies.routes.js';
import { registerReviewRoutes } from './modules/review/review.routes.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerAgentRoutes(app);
  await registerEnterpriseRoutes(app);
  await registerEnterpriseProfileRoutes(app);
  await registerPolicyRoutes(app);
  await registerPolicyQaRoutes(app);
  await registerEligibilityRoutes(app);
  await registerApplicationRoutes(app);
  await registerFileRoutes(app);
  await registerMaterialRoutes(app);
  await registerOcrRoutes(app);
  await registerReviewRoutes(app);
  await registerAdminRoutes(app);
  await registerFrontendRoutes(app);
}
