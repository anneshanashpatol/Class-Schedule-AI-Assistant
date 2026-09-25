import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

function required(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(`Cloudflare Builds 中缺少 ${name}`); return value; }
const databaseId = required('BUILD_AI_D1_DATABASE_ID');
const zoneId = required('BUILD_ZONE_ID');
if (!/^[a-f0-9-]{36}$/i.test(databaseId)) throw new Error('BUILD_AI_D1_DATABASE_ID 格式无效');
if (!/^[a-f0-9]{32}$/i.test(zoneId)) throw new Error('BUILD_ZONE_ID 格式无效');
const host = process.env.BUILD_ASSISTANT_HOST?.trim() || 'qcp.dpdns.org';
if (!/^[a-z0-9.-]+$/i.test(host) || host.includes('..')) throw new Error('BUILD_ASSISTANT_HOST 格式无效');
const name = process.env.BUILD_ASSISTANT_WORKER_NAME?.trim() || 'course-scheduler-assistant';
const mainName = process.env.BUILD_MAIN_WORKER_NAME?.trim() || 'course-scheduler';
const config = {
  $schema: 'node_modules/wrangler/config-schema.json', name, main: 'server/index.ts',
  compatibility_date: '2026-09-22', keep_vars: true, workers_dev: false,
  assets: { directory: './dist', binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: true },
  services: [{ binding: 'MAIN_APP', service: mainName }],
  d1_databases: [{ binding: 'AI_DB', database_name: process.env.BUILD_AI_D1_DATABASE_NAME?.trim() || 'course-scheduler-assistant-db', database_id: databaseId, migrations_dir: 'migrations' }],
  routes: [
    { pattern: `${host}/assistant`, zone_id: zoneId },
    { pattern: `${host}/assistant/*`, zone_id: zoneId },
  ], observability: { enabled: true },
};
await writeFile('wrangler.production.jsonc', `${JSON.stringify(config, null, 2)}\n`);
const wrangler = 'node_modules/wrangler/bin/wrangler.js';
const dryRun = process.argv.includes('--dry-run');
const commands = dryRun
  ? [[wrangler, 'deploy', '--dry-run', '--config', 'wrangler.production.jsonc']]
  : [
      [wrangler, 'd1', 'migrations', 'apply', 'AI_DB', '--remote', '--config', 'wrangler.production.jsonc'],
      [wrangler, 'deploy', '--config', 'wrangler.production.jsonc'],
    ];
for (const args of commands) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, CI: 'true' } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
