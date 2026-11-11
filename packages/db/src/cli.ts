#!/usr/bin/env node
// Database CLI: `migrate`, `seed`, `check-rls`. Reads connection strings from the environment.
import { runMigrations } from './migrate.js';
import { checkRlsCoverage } from './rls-check.js';
import { seedDemo } from './seed/seed.js';
import { contentSeedSteps } from './seed/steps.js';

const LOCAL = 'postgres://%s@localhost:55432/resourcehub';
const env = (key: string, fallback: string) => process.env[key] ?? fallback;

const migratorUrl = env(
  'DATABASE_URL_MIGRATOR',
  LOCAL.replace('%s', 'resourcehub_migrator:migrator_dev_pw'),
);
const platformUrl = env(
  'DATABASE_URL_PLATFORM',
  LOCAL.replace('%s', 'resourcehub_platform:platform_dev_pw'),
);

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'migrate':
      await runMigrations(migratorUrl);
      console.log('Migrations applied.');
      return;
    case 'seed':
      await seedDemo(platformUrl, contentSeedSteps);
      console.log('Demo tenants seeded: contoso, northwind.');
      return;
    case 'check-rls': {
      const violations = await checkRlsCoverage(migratorUrl);
      if (violations.length > 0) {
        console.error('RLS coverage check FAILED:');
        for (const v of violations) console.error(`  - ${v.table}: ${v.problem}`);
        process.exitCode = 1;
        return;
      }
      console.log('RLS coverage check passed: every table has RLS + FORCE + a policy.');
      return;
    }
    default:
      console.error('Usage: resourcehub-db <migrate|seed|check-rls>');
      process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
