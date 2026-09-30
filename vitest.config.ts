import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      '@nexa/shared': path.resolve(__dirname, './packages/shared/src/index.ts'),
      '@nexa/security': path.resolve(__dirname, './packages/security/src/index.ts'),
      '@nexa/database': path.resolve(__dirname, './packages/database/src/index.ts'),
      '@nexa/browser': path.resolve(__dirname, './packages/browser/src/index.ts'),
      '@nexa/tools': path.resolve(__dirname, './packages/tools/src/index.ts'),
      '@nexa/ai': path.resolve(__dirname, './packages/ai/src/index.ts'),
      '@nexa/whatsapp': path.resolve(__dirname, './packages/whatsapp/src/index.ts'),
      '@nexa/agent': path.resolve(__dirname, './packages/agent/src/index.ts'),
    },
  },
});
