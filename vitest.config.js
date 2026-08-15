// Vitest config for frontend unit tests.
// 跑 tests/frontend/ 下的 *.test.js；用 jsdom 模拟 DOM。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/frontend/**/*.test.js'],
    globals: true,
  },
});