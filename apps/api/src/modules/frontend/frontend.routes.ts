import fs from 'node:fs/promises';
import path from 'node:path';
import { type FastifyInstance } from 'fastify';

function resolvePublicDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith(path.join('apps', 'api'))) {
    return path.resolve(cwd, '..', 'web', 'public');
  }
  return path.resolve(cwd, 'apps', 'web', 'public');
}

function resolveWebSrcDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith(path.join('apps', 'api'))) {
    return path.resolve(cwd, '..', 'web', 'src');
  }
  return path.resolve(cwd, 'apps', 'web', 'src');
}

const publicDir = resolvePublicDir();
const webSrcDir = resolveWebSrcDir();

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const frontendRoutes = [
  '/',
  '/login',
  '/register',
  '/select-role',
  '/forgot-password',
  '/reset-password',
  '/profile',
  '/403',
  '/404',
  '/500',
  '/logout',
  '/enterprise/*',
  '/gov/*',
  '/admin/*',
] as const;

export async function registerFrontendRoutes(app: FastifyInstance): Promise<void> {
  app.get('/styles.css', async (_request, reply) => {
    const content = await fs.readFile(path.join(publicDir, 'styles.css'));
    return reply.type(contentTypes['.css']).send(content);
  });

  app.get('/app.js', async (_request, reply) => {
    const content = await fs.readFile(path.join(publicDir, 'app.js'));
    return reply.type(contentTypes['.js']).send(content);
  });

  app.get('/src/*', async (request, reply) => {
    const requestedPath = (request.params as { '*': string })['*'];
    const resolvedPath = path.resolve(webSrcDir, requestedPath);
    const extension = path.extname(resolvedPath);
    if (!resolvedPath.startsWith(webSrcDir) || !['.js', '.css'].includes(extension)) {
      return reply.code(404).send('Not found');
    }
    const content = await fs.readFile(resolvedPath);
    return reply.type(contentTypes[extension]).send(content);
  });

  for (const route of frontendRoutes) {
    app.get(route, async (_request, reply) => {
      const content = await fs.readFile(path.join(publicDir, 'index.html'));
      return reply.type(contentTypes['.html']).send(content);
    });
  }
}
