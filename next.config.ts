import type { NextConfig } from 'next';

const config: NextConfig = {
  // A separate build folder can be used for a local production check without touching a running dev server.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // PGlite ships a WebAssembly Postgres; keep it out of the server bundle.
  // pdfkit reads its font files from disk at run time, so it is not bundled either.
  // pg is the hosted (Supabase) driver.
  serverExternalPackages: ['@electric-sql/pglite', 'pdfkit', 'pg'],
  // Files read from disk at run time must be copied into the hosted functions.
  outputFileTracingIncludes: { '/**': ['./node_modules/pdfkit/js/data/**'] },
};

export default config;
