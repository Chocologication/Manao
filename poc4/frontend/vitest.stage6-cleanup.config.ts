import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/stage6-cleanup-*.test.ts'],
    restoreMocks: true,
  },
});
