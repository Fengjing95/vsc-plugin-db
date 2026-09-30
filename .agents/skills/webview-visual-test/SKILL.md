---
name: webview-visual-test
description: 在浏览器中无宿主可视化测试本仓库 VSCode 插件的 webview（packages/webview-ui）——stub 掉 acquireVsCodeApi 与 --vscode-* 主题变量后加载 dist 构建产物，用浏览器自动化做截图/交互/回归验证。凡改动 webview UI（表格页、连接表单、工具栏、弹窗、网格）需要实机视觉效果验证，用户要求"看效果/截图/可视化验证/预览一下"，或需要复现仅 UI 层渲染问题（如虚拟列表、粘性列、弹层）时使用。
---

# Webview 无宿主可视化测试

脱离 VSCode 宿主在真实浏览器里跑 webview：`acquireVsCodeApi()` 在模块加载即被调用、所有颜色依赖 `--vscode-*` 变量，直接打开产物会白/黑屏。本 skill 用 stub 页解决这两件事，让页面可以真实交互与截图。

## 工作流

1. **构建产物**（源码有改动时必须先构建，产物哈希变化后 stub 自动引用新文件）：
   ```bash
   pnpm --filter @db-explorer/webview-ui build
   ```

2. **起 stub 服务**（仓库根目录；Ctrl+C 结束）：
   ```bash
   # 默认表格页场景
   node .agents/skills/webview-visual-test/scripts/make-stub.mjs
   # 自定义场景：复制 scripts/handlers.example.js 改名后编辑 handlers，再指定
   node .agents/skills/webview-visual-test/scripts/make-stub.mjs scripts/我的场景.js --port 8931
   ```
   脚本会把 `dist/` 产物拷到临时目录、注入 Dark Modern 主题变量 + `acquireVsCodeApi` 桩 + 场景脚本，输出 `http://127.0.0.1:8931/index.html`。

3. **写场景**：handlers 文件是浏览器侧 JS，定义 `window.__DBX_STUB__ = { delayMs?, bootstrap?, handlers }`；`handlers` 按 RPC 方法名映射到 `(params) => result`（可同步可抛错，桩负责包成 res 帧异步回放）。从 `scripts/handlers.example.js` 复制改。要点：
   - 场景要覆盖要验证的状态：预览弹窗需要 `table.previewChanges` 带 `params`（回填展示）、DDL 弹窗需要 `table.getDdl`、编辑态直接在前端操作即可（`editChanges` 返回任意 counts 即可，本地覆盖层自驱动）。
   - 未实现的方法返回 `E_UNKNOWN_METHOD`，页面按错误路径展示——正好可顺带验证错误 UI。

4. **驱动浏览器**：加载 `control-browser` skill（browser-use），按其规则打开 URL——`tab.playwright.domSnapshot()` 读结构、按 aria-label/role 定位（本仓库组件均带中文 aria-label）、`tab.screenshot()` 前先 `nodeRepl.write(await agent.documentation.get("screenshots"))` 并用 `nodeRepl.emitImage` 发出。视觉回归对照历史截图逐区域裁剪比对。

5. **清理**：`tab.close()` 关标签；服务进程 Ctrl+C 结束。stub 页在 /tmp，无需清理仓库。

## 判回归与排查

- **疑似改动引入的回归**：`git stash` 后对 HEAD 构建 `make-stub` 同页复测对照；两者都异常是预置问题，仅新构建异常才是回归。
- **整页黑底/文字不可见**：主题变量缺失（stub 未生效或被绕过），不是渲染 bug。
- **弹层内虚拟列表空白**：先读 `references/pitfalls.md` 的 P-21——这是挂载时序问题，有既定修复模式。
- **性能类断言失败**：`dod.perf.test.ts` 对机器负载敏感，先 `npx vitest run <file>` 隔离复跑再下结论。

## 边界

- 本 skill 只做**视觉/交互验证**；提交前仍须跑完整四道门禁（C-1）。
- stub 无法覆盖 VSCode 宿主行为（SecretStorage、DangerGuard 输入框、webview CSP/nonce）。涉及宿主交互的改动，stub 验证后仍建议 F5 实机确认。
