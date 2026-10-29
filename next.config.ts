import type { NextConfig } from 'next';

const config: NextConfig = {
  // PGlite ships a WebAssembly Postgres; keep it out of the server bundle.
  serverExternalPackages: ['@electric-sql/pglite'],
};

export default config;
