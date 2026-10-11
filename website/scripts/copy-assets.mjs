// 构建期把仓库内权威素材拷入 website/public/assets（产物不入库，见根 .gitignore）：
//   - docs/images/*.png                          → 界面截图（README/Marketplace 同源）
//   - packages/extension/media/extension-icon.svg → 品牌图标（favicon）
//   - packages/webview-ui/src/assets/logos/*.svg  → 驱动品牌 logo（矩阵表头）
// 素材更新只需改权威源，重跑本脚本即可，禁止把产物提交进仓库造成双源漂移。
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const assetsDir = join(repoRoot, 'website', 'public', 'assets');

const dirCopies = [
  {
    src: join(repoRoot, 'docs', 'images'),
    dest: join(assetsDir, 'images'),
    ext: '.png',
  },
  {
    src: join(repoRoot, 'packages', 'webview-ui', 'src', 'assets', 'logos'),
    dest: join(assetsDir, 'logos'),
    ext: '.svg',
  },
];

const fileCopies = [
  {
    src: join(repoRoot, 'packages', 'extension', 'media', 'extension-icon.svg'),
    dest: join(assetsDir, 'favicon.svg'),
  },
];

await rm(assetsDir, { recursive: true, force: true });
await mkdir(assetsDir, { recursive: true });
for (const { src, dest, ext } of dirCopies) {
  // cp 的 filter 对源目录本身也会调用一次，须放行
  await cp(src, dest, { recursive: true, filter: (s) => s === src || s.endsWith(ext) });
}
for (const { src, dest } of fileCopies) {
  await cp(src, dest);
}
console.log('[copy-assets] 素材已拷入 website/public/assets');
