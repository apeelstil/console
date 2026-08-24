import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  applyDevelopmentContentSecurityPolicy,
  DEVELOPMENT_CONTENT_SECURITY_POLICY,
  PRODUCTION_CONTENT_SECURITY_POLICY,
} from '../shared/contentSecurityPolicy';

const productionIndex = readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
const viteConfig = readFileSync(path.resolve(process.cwd(), 'vite.config.mts'), 'utf8');

test('production CSP remains strict and does not allow inline styles', () => {
  assert.ok(productionIndex.includes(PRODUCTION_CONTENT_SECURITY_POLICY));
  assert.equal(PRODUCTION_CONTENT_SECURITY_POLICY.includes("'unsafe-inline'"), false);
});

test('development CSP allows only the inline styles and IPv4 endpoints required by Vite', () => {
  const developmentIndex = applyDevelopmentContentSecurityPolicy(productionIndex);
  assert.ok(developmentIndex.includes(DEVELOPMENT_CONTENT_SECURITY_POLICY));
  assert.equal(developmentIndex.includes(PRODUCTION_CONTENT_SECURITY_POLICY), false);
  assert.ok(DEVELOPMENT_CONTENT_SECURITY_POLICY.includes("style-src 'self' 'unsafe-inline'"));
  assert.ok(DEVELOPMENT_CONTENT_SECURITY_POLICY.includes('ws://127.0.0.1:*'));
  assert.ok(DEVELOPMENT_CONTENT_SECURITY_POLICY.includes('http://127.0.0.1:*'));
  assert.ok(viteConfig.includes(DEVELOPMENT_CONTENT_SECURITY_POLICY));
});
