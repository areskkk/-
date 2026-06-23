import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { haystackClient } from '../src/modules/rag/haystack.client.js';

describe('rag sidecar internal authentication', () => {
  const previousBaseUrl = process.env.RAG_SERVICE_BASE_URL;
  const previousApiKey = process.env.RAG_SERVICE_INTERNAL_API_KEY;

  afterEach(() => {
    process.env.RAG_SERVICE_BASE_URL = previousBaseUrl;
    process.env.RAG_SERVICE_INTERNAL_API_KEY = previousApiKey;
  });

  it('sends the configured internal api key to the sidecar', async () => {
    let receivedKey: string | undefined;
    const server = http.createServer((request, response) => {
      receivedKey = request.headers['x-internal-api-key'] as string | undefined;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        backend_mode: 'haystack_inmemory',
        results: [],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('failed to start local rag auth test server');
    }

    process.env.RAG_SERVICE_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.RAG_SERVICE_INTERNAL_API_KEY = 'test-internal-rag-key';

    try {
      await haystackClient.search({
        query: 'policy',
        limit: 1,
      });
      expect(receivedKey).toBe('test-internal-rag-key');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
