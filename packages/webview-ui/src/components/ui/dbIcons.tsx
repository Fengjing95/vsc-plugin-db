import type { ReactElement } from 'react';
import { DB_LOGO_SVGS, type DbLogoSvg } from '../dbIcons.generated';

/**
 * 数据库品牌图标（M8-PG B7）：内联 SVG 渲染（CSP 安全，无外链/无 img-src 指令）。
 * 素材由 scripts/generate-db-icons.mjs 从 src/assets/logos/*.svg 构建期提取（产物提交入库）；
 * 宽幅 logo（如 MySQL 1877×1024）不设 width，按 viewBox 纵横比自适应、不拉伸。
 * 无素材的驱动回落 emoji（外观装饰，不影响逻辑）。
 */

/** driverId → 生成素材 key（文件名小写）的别名归一 */
const DRIVER_LOGO_KEYS: Record<string, string> = {
  mysql: 'mysql',
  postgres: 'postgresql',
  postgresql: 'postgresql',
  redis: 'redis',
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  mongodb: 'mongodb',
  mongo: 'mongodb',
};

/** 无素材驱动的 emoji 回落（与既有卡片视觉延续；未知驱动走通用图标） */
const DRIVER_EMOJI: Record<string, string> = {
  mysql: '🐬',
  postgres: '🐘',
  postgresql: '🐘',
  redis: '⚡',
  sqlite: '🪶',
  sqlite3: '🪶',
  mongodb: '🍃',
  mongo: '🍃',
  mock: '🧪',
};

export function DbDriverIcon({ driverId, size = 18 }: { driverId: string; size?: number }): ReactElement {
  const logo: DbLogoSvg | undefined = DB_LOGO_SVGS[DRIVER_LOGO_KEYS[driverId] ?? ''];
  if (!logo) {
    return <span className="leading-none">{DRIVER_EMOJI[driverId] ?? '🗄'}</span>;
  }
  return (
    <svg viewBox={logo.viewBox} height={size} aria-hidden focusable="false" className="block">
      {logo.paths.map((p, i) => (
        <path key={i} d={p.d} fill={p.fill} />
      ))}
    </svg>
  );
}
