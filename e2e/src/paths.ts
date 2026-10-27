import { dirname, join } from 'node:path';

/** runner 以 `node dist/runner.cjs` 入口运行（argv[1] 为绝对路径）→ dist → e2e → 仓库根 */
const entryDir = dirname(process.argv[1] ?? '.');

export const E2E_ROOT = join(entryDir, '..');
export const REPO_ROOT = join(E2E_ROOT, '..');
export const EXTENSION_DIR = join(REPO_ROOT, 'packages', 'extension');
export const TEST_EXTENSION_DIR = join(E2E_ROOT, 'test-extension');
export const ARTIFACTS_ROOT = join(E2E_ROOT, 'artifacts');
/** @vscode/test-electron 的 VSCode 二进制缓存（仓库根 .vscode-test，已被 .gitignore） */
export const VSCODE_CACHE_DIR = join(REPO_ROOT, '.vscode-test');
