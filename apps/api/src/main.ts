import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';

const env = loadEnv();
const app = await buildApp();

await app.listen({
  host: env.host,
  port: env.port,
});
