import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

interface PackageMetadata {
  version: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  build: {
    files: string[];
    win: {
      target: Array<{ target: string; arch: string[] }>;
    };
  };
}

const packagePath = path.resolve(process.cwd(), 'package.json');
const metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as PackageMetadata;

test('package metadata identifies the verified 1.0.0 release', () => {
  assert.equal(metadata.version, '1.0.0');
});

test('portable package keeps only main-process runtime dependencies', () => {
  assert.deepEqual(
    Object.keys(metadata.dependencies).sort(),
    ['better-sqlite3', 'pg', 'pgsql-parser'],
  );

  for (const buildDependency of ['@vitejs/plugin-react', 'react', 'react-dom', 'typescript', 'vite']) {
    assert.equal(typeof metadata.devDependencies[buildDependency], 'string');
  }
});

test('portable package targets Windows x64 and excludes foreign better-sqlite3 binaries', () => {
  assert.deepEqual(metadata.build.win.target, [{ target: 'portable', arch: ['x64'] }]);
  assert.deepEqual(
    metadata.build.files.filter((entry) => !entry.startsWith('!')),
    ['dist/**/*', 'dist-electron/**/*', 'package.json'],
  );
  assert.ok(metadata.build.files.includes('!node_modules/better-sqlite3/prebuilds/darwin-*.node'));
  assert.ok(metadata.build.files.includes('!node_modules/better-sqlite3/prebuilds/linux*.node'));
  assert.ok(metadata.build.files.includes('!node_modules/better-sqlite3/prebuilds/win32-arm64.node'));
});

test('development, tests, and production builds remove stale Electron output before emitting files', () => {
  assert.match(metadata.scripts.dev ?? '', /npm run clean:electron/);
  assert.match(metadata.scripts.test ?? '', /npm run clean:electron/);
  assert.match(metadata.scripts.build ?? '', /npm run clean:electron/);
  assert.equal(existsSync(path.resolve('electron/storage/credentialStorage.ts')), false);
  assert.equal(existsSync(path.resolve('dist-electron/electron/storage/credentialStorage.js')), false);
});
