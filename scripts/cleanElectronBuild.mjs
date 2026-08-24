import { realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const workspaceRoot = realpathSync(process.cwd());
const target = path.resolve(workspaceRoot, 'dist-electron');

if (path.dirname(target) !== workspaceRoot) {
  throw new Error('Refusing to clean an Electron build directory outside the workspace.');
}

rmSync(target, { recursive: true, force: true });
