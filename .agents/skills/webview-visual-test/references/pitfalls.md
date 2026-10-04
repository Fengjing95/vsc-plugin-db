# 排查手册：stub 预览环境的已知坑（与 AGENTS.md P-20/P-21 同源，此处展开操作细节）

## 整页黑底、文字几乎不可见

- 症状：截图全黑，只有 emoji（如 🔍）可见。
- 根因：tokens.css 全部颜色映射 `--vscode-*`，脱离宿主后未定义 → 颜色塌陷为初始值/透明。
- 判定：不是渲染 bug。检查 make-stub 是否注入了 `<style>:root{--vscode-…}`；自建 stub 页漏注入就会这样。

## 弹层（Dialog）内虚拟列表空白——P-21

- 症状：ChangePreviewModal 顶部统计行、底部按钮正常，中间语句区空白；滚动容器有正确高度，内层 div `height` 也算出来了（= 条数 × 行高），但 `children.length === 0`。
- 根因：Base UI Dialog 的 portal 内容比持有 `useVirtualizer` 的组件**晚一个 commit 挂载**；`useVirtualizer` 的无依赖 layout effect（virtual-core `_willUpdate`）在滚动容器 ref 就绪前运行且此后组件未再渲染 → `scrollElement` 恒为 null、永不订阅 ResizeObserver → `getVirtualItems()` 恒空。
- 验证手法（React fiber 探针，浏览器 console 或 evaluate 执行）：
  1. `document.querySelectorAll('[role="dialog"]')` 取弹窗，`querySelector('.overflow-auto')` 取滚动容器；
  2. 沿 `__reactFiber$xxx` 的 `.return` 链找组件（生产构建名字被压缩，按 hooks 内容辨认），遍历 hooks 链找含 `options`/`scrollElement` 的对象即 Virtualizer 实例；
  3. 看 `scrollElement` 是否为 null、`unsubs.length` 是否为 0——为 null/0 即本坑。
- 修复模式：**虚拟列表与其滚动容器抽成同一子组件**（同 commit 挂载，ref 就绪先于子组件 layout effect）。ChangePreviewModal 的 `SqlList` 是参照实现。任何在 Dialog/Popover 内新用 `useVirtualizer` 的地方都必须照此模式。
- 复现基线：M4 前的 HEAD 构建同样空白（当时误判为无头环境怪癖，后经实机确认为真实 bug）——"HEAD 也一样"只能排除新回归，不能证明无 bug。

## ResizeObserver 探针

怀疑某个元素"从未被观察/从未触发尺寸回调"时，在页面最前（业务脚本之前）hook：

```js
const RO_LOG = [];
const OrigRO = window.ResizeObserver;
window.ResizeObserver = class extends OrigRO {
  constructor(cb) {
    super((entries, o) => {
      RO_LOG.push(entries.map((e) => [e.target.tagName, String(e.target.className).slice(0, 40), Math.round(e.contentRect.width), Math.round(e.contentRect.height), e.target.isConnected]));
      return cb(entries, o);
    });
  }
  observe(t, opt) { RO_LOG.push(['observe', t.tagName, String(t.className).slice(0, 40), t.isConnected]); return super.observe(t, opt); }
};
```

`observe` 记录缺失 = 元素从未被订阅（挂载时序问题）；有 observe 但 dispatch 尺寸异常 = 布局时机问题。该环境（IAB 无头）RO 本身工作正常，可直接信任其行为。

## 判回归的对照法

1. `git stash push -m wip` → `pnpm --filter @db-explorer/webview-ui build` → `make-stub.mjs` 起服务，记录现象；
2. `git stash pop` → 重新构建 → 复测同一交互路径；
3. 两者表现一致 = 预置问题/环境特性；仅新构建异常 = 本次改动引入。
   注意对照页要用**不同文件名**（如 `head.html`）或每次重拷产物，避免浏览器缓存串页。

## 性能测试抖动

`dod.perf.test.ts` 是墙钟阈值断言；全量并发 + 机器高负载（load > 5）时 `M4 DoD 提交 100 条变更 <2s` 会假红。先隔离复跑 `npx vitest run packages/driver-mock/src/dod.perf.test.ts`，或 `npx vitest run --maxWorkers=1`；隔离下 700ms 左右即正常，与本仓库 UI 改动无关（该测试直跑 mock 驱动，不经过 webview/RPC）。

## RPC 桩语义

- 请求帧 `{ kind: 'req', id, method, params }`；响应帧 `{ kind: 'res', id, ok, result | error }` 通过 `window.dispatchEvent(new MessageEvent('message', { data: frame }))` 回放（rpc/client 监听 window message）。
- 桩延迟 60ms 足够让 loading 态可见；要测竞态可调 `delayMs` 或在 handler 里返回 Promise。
- `evt:` 推送事件（export.progress / changeset.updated / row.error）默认不发；需要时在 handler 里 `window.dispatchEvent(new MessageEvent('message', { data: { kind: 'evt', event: 'evt:changeset.updated', payload: { counts: {...} } } }))`——注意 changeset.updated 计数全 0 会清空本地覆盖层（TablePage 语义），可用来测"提交成功清空"路径。

## stub 单实例（M8 踩）

`make-stub.mjs` 输出目录固定（`$TMPDIR/dbx-webview-preview`），启动时 `rmSync` 清空——**两个实例并行启动会 ENOTEMPTY 崩掉其中一个**。多场景验证必须串行：起一个 → 测完停 → 再起下一个（换端口没用，争的是目录不是端口）。

## 场景数据要过 webview zod 校验（M8 踩）

handler 返回值会按 `@db-explorer/protocol` schema 在 webview 侧 `safeParse`，形状不符走错误路径（如 Console 页显示「插件与视图版本不一致」，看似构建产物过期，实为数据形状错）。典型：`ConsoleStateResult.running` 是 `.optional()`（缺省=undefined）**不是 nullable**，场景里写 `running: null` 必炸——可选字段的"无"一律省略键或给 undefined，对照 `methods.ts` schema 写场景。
