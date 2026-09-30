import Prism from 'prismjs';

/**
 * prism 组件桥接（P-21 前置）：components/prism-sql.js 裸引用全局 `Prism`，
 * ESM 打包下必须先在 globalThis 暴露实例，后续语言组件 import 才能挂载成功。
 * sqlHighlight.ts 以 import 声明顺序保证本模块先于 prism-sql 执行。
 */
(globalThis as unknown as { Prism: typeof Prism }).Prism = Prism;
