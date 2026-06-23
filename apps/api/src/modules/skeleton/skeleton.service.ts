import {
  type SkeletonResponse,
  skeleton,
} from '../../common/response/api-response.js';

export class SkeletonService {
  respond(module: string, action: string): SkeletonResponse {
    return skeleton(module, action);
  }
}

export const skeletonService = new SkeletonService();
