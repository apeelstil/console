import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const productionContentSecurityPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*";
const developmentContentSecurityPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:* ws://localhost:* http://localhost:*";

function applyDevelopmentContentSecurityPolicy(html: string): string {
  if (!html.includes(productionContentSecurityPolicy)) {
    throw new Error('The production Content Security Policy marker is missing from index.html.');
  }
  return html.replace(productionContentSecurityPolicy, developmentContentSecurityPolicy);
}

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    ...(command === 'serve'
      ? [{
          name: 'supra-development-csp',
          transformIndexHtml: applyDevelopmentContentSecurityPolicy,
        }]
      : []),
  ],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
}));
