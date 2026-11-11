import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

// SWC keeps decorator metadata (needed by NestJS DI); esbuild drops it.
const plugins = [swc.vite({ module: { type: 'es6' } })];

export default defineConfig({
  test: {
    projects: [
      {
        plugins,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        plugins,
        test: {
          name: 'integration',
          include: ['test/**/*.test.ts'],
          exclude: ['test/unit/**'],
          environment: 'node',
          globalSetup: ['test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
