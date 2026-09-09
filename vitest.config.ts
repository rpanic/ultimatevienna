import { defineConfig } from 'vitest/config';

// Vitest config, kept separate from astro.config.mjs so lib tests run in a
// plain Node environment without pulling in the Astro/Tailwind pipeline.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Populate process.env from .env before test modules import sheets.ts,
    // which reads Google credentials at module-load time. See setup-env.ts.
    setupFiles: ['src/test/setup-env.ts'],
  },
});