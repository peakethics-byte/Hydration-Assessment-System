import type { NextConfig } from 'next';

const config: NextConfig = {
  // PGlite ships a WebAssembly Postgres; keep it out of the server bundle.
  // pdfkit reads its font files from disk at run time, so it is not bundled either.
  serverExternalPackages: ['@electric-sql/pglite', 'pdfkit'],
};

export default config;
