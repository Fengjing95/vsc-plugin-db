/**
 * 浏览器 stub：官网 Playground 不打包 node-sql-parser（体积大且存在 node 内建依赖面）。
 * core 的 sqlDanger 对 astify 抛错自带正则降级路径（fail-closed，P-24），判定行为保持正确。
 */
export class Parser {
  constructor(_options?: unknown) {}

  astify(): never {
    throw new Error('node-sql-parser 已在官网 Playground 中 stub，走 sqlDanger 正则降级');
  }

  sqlify(): never {
    throw new Error('node-sql-parser 已在官网 Playground 中 stub');
  }
}
