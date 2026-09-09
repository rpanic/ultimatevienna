import { loadEnv } from 'vite';

// Vitest runs outside Vite's app pipeline and does not load `.env` on its own.
// But `src/lib/sheets.ts` reads the Google service-account credentials from
// process.env at module-import time (the top-level SPREADSHEET_ID / CLIENT_EMAIL
// / PRIVATE_KEY consts), so the test modules must see those values BEFORE they
// import sheets.ts. This setup file runs before each test file's imports.
//
// `loadEnv(mode, dir, '')` with an empty prefix returns every var defined in
// `.env` / `.env.local` / `.env.<mode>` (plus the existing process.env). We
// copy them into process.env without overwriting anything already set there.
//
// Nothing here is logged: `.env` contains real service-account credentials and
// must never be printed or exposed.
const env = loadEnv('test', process.cwd(), '');
for (const [key, value] of Object.entries(env)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}