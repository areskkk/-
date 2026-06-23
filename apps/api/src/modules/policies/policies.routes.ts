import { type FastifyInstance } from 'fastify';
import { ok } from '../../common/response/api-response.js';
import { policyService } from './policies.service.js';

type ListPolicyQuery = {
  page?: number;
  page_size?: number;
};

export async function registerPolicyRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListPolicyQuery }>('/api/v1/policies', async (request) => {
    return ok(
      await policyService.listPolicies(request.query),
      request.context.trace_id,
    );
  });

  app.get<{ Params: { policy_id: string } }>('/api/v1/policies/:policy_id', async (request) => {
    return ok(
      await policyService.getPolicyDetail(request.params.policy_id),
      request.context.trace_id,
    );
  });
}
