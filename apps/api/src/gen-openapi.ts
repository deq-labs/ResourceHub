// Build-time OpenAPI generation: boots the Nest app without listening (pools and Redis are
// lazy, so nothing connects) and writes packages/contracts/openapi.json.
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.factory.js';
import { loadConfig } from './config.js';
import { buildOpenApi } from './openapi.js';

const out = fileURLToPath(new URL('../../../packages/contracts/openapi.json', import.meta.url));
const app = await createApp(loadConfig({ NODE_ENV: 'test' }));
const doc = buildOpenApi(app);
writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
await app.close();
console.log(`OpenAPI written to ${out} (${Object.keys(doc.paths).length} paths)`);
