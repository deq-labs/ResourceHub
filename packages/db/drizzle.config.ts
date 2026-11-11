import { defineConfig } from 'drizzle-kit';

// drizzle-kit reads the compiled schema (ESM `.js` imports trip its TS loader).
// Run `pnpm build` first; `pnpm db:generate` does that for you.
export default defineConfig({
  dialect: 'postgresql',
  schema: './dist/schema/index.js',
  out: './drizzle',
  dbCredentials: {
    url:
      process.env.DATABASE_URL_MIGRATOR ??
      'postgres://resourcehub_migrator:migrator_dev_pw@localhost:55432/resourcehub',
  },
});
