import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

interface PackageMetadata {
  version: string;
  description: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  build: {
    productName: string;
    executableName: string;
    copyright: string;
    afterPack: string;
    extraResources?: string[];
    files: string[];
    win: {
      icon: string;
      target: Array<{ target: string; arch: string[] }>;
    };
  };
}

const packagePath = path.resolve(process.cwd(), 'package.json');
const metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as PackageMetadata;

test('package metadata identifies the verified 1.0.0 release', () => {
  assert.equal(metadata.version, '1.0.0');
});

test('Windows package uses SUPRA branding without invented publisher metadata', () => {
  assert.equal(metadata.description, 'SUPRA Query Console');
  assert.equal(metadata.build.productName, 'SUPRA Query Console');
  assert.equal(metadata.build.executableName, 'SUPRA-Query-Console');
  assert.equal(metadata.build.copyright, '');
  assert.equal(metadata.build.afterPack, 'scripts/stripUnsupportedWindowsMetadata.mjs');
  assert.equal(metadata.build.win.icon, 'assets/supra-icon.ico');
  assert.ok(metadata.build.files.includes('assets/supra-icon.ico'));
  assert.equal(existsSync(path.resolve('assets/supra-icon.png')), true);
  assert.equal(existsSync(path.resolve('assets/supra-icon.ico')), true);
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
    ['dist/**/*', 'dist-electron/**/*', 'assets/supra-icon.ico', 'package.json'],
  );
  assert.ok(metadata.build.files.includes('!node_modules/better-sqlite3/prebuilds/darwin-*.node'));
  assert.ok(metadata.build.files.includes('!node_modules/better-sqlite3/prebuilds/linux*.node'));
  assert.ok(metadata.build.files.includes('!node_modules/better-sqlite3/prebuilds/win32-arm64.node'));
});

test('local SQLite remains per-user and cannot be bundled or accidentally committed', () => {
  const mainSource = readFileSync(path.resolve('electron/main.ts'), 'utf8');
  const ignoreRules = readFileSync(path.resolve('.gitignore'), 'utf8');

  assert.match(
    mainSource,
    /path\.join\(app\.getPath\('userData'\), LOCAL_DATABASE_FILENAME\)/,
  );
  assert.doesNotMatch(mainSource, /PORTABLE_EXECUTABLE_DIR|process\.execPath|process\.cwd\(\)/);
  assert.equal(metadata.build.extraResources, undefined);
  assert.equal(
    metadata.build.files.some(
      (entry) => !entry.startsWith('!') && /\.db(?:-wal|-shm)?(?:$|[*])/i.test(entry),
    ),
    false,
  );
  assert.ok(metadata.build.files.includes('!**/*.db'));
  assert.ok(metadata.build.files.includes('!**/*.db-wal'));
  assert.ok(metadata.build.files.includes('!**/*.db-shm'));
  assert.match(ignoreRules, /^\*\.db$/m);
  assert.match(ignoreRules, /^\*\.db-wal$/m);
  assert.match(ignoreRules, /^\*\.db-shm$/m);
  assert.equal(existsSync(path.resolve('electron/storage/credentialStorage.ts')), false);
  assert.equal(existsSync(path.resolve('tests/safeStorageIntegration.ts')), false);
});

test('development, tests, and production builds remove stale Electron output before emitting files', () => {
  assert.match(metadata.scripts.dev ?? '', /npm run clean:electron/);
  assert.match(metadata.scripts.test ?? '', /npm run clean:electron/);
  assert.match(metadata.scripts.build ?? '', /npm run clean:electron/);
  assert.equal(existsSync(path.resolve('electron/storage/credentialStorage.ts')), false);
  assert.equal(existsSync(path.resolve('dist-electron/electron/storage/credentialStorage.js')), false);
});
