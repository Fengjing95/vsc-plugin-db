---
name: gha-run-inspect
description: 在本机无 gh CLI、无 GitHub 凭据时，用匿名可读的 GitHub API 逐层排查本仓库（Fengjing95/vsc-plugin-db）CI/Release 运行结果——确认 run 结论、定位失败 step、拉取 vitest 失败详情注记。用户贴出 Actions run/job 链接要求「看下结果 / 排查 / 为什么红」，或推送后需要远程确认 CI/Release 状态时使用。
---

# GitHub Actions 运行结果排查（匿名可读通道）

本机事实：`gh` CLI 不可用（command not found）；Actions 日志页需登录才能看完整输出。但**公开仓库**的三类内容匿名可读：run/job 元数据 API、check-run 注记（annotations）、运行摘要（Summary，随 CI/Release 的「失败输出转运行摘要与注记」步骤写入）。本仓库的失败诊断链路就是围绕这三层设计的——这个 skill 按同样的层次下钻。

## 工作流（三步下钻）

### 1. run 概要：确认「哪个提交、哪条流水线、结论」

```bash
curl -s "https://api.github.com/repos/Fengjing95/vsc-plugin-db/actions/runs/<run_id>" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); \
print(d['name'], d['event'], d['status'], d['conclusion'], d['head_sha'][:7], d['run_attempt'])"
```

- `name` 区分 **CI**（push main / PR）与 **Release**（tag 推送触发）；`head_sha` 对照 `git log` 确认是哪个提交。
- 同一 tag 多次重打后会出现多个 Release run，`created_at` + `head_sha` 区分是哪一轮。

### 2. jobs：定位失败 step 并取 check_run id

```bash
curl -s "https://api.github.com/repos/Fengjing95/vsc-plugin-db/actions/runs/<run_id>/jobs?per_page=1" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); j=d['jobs'][0]; \
print('job:', j['id'], j['conclusion']); \
print(j['check_run_url']); \
[print('FAILED STEP:', s['name']) for s in j['steps'] if s['conclusion']=='failure']"
```

- **job 的 `id` 即 check-run id**（`check_run_url` 尾段同值），第三步直接用。
- 失败 step 名能快速分流：挂在「测试」→ 走第 3 步拉注记；挂在「等待 SQL Server 就绪」→ 服务问题不是测试问题；「发布守卫」→ 版本三处同步（tag/version/CHANGELOG）不一致。

### 3. annotations：拉取失败详情（本仓库注记里就有 vitest 失败全文）

```bash
curl -s "https://api.github.com/repos/Fengjing95/vsc-plugin-db/check-runs/<check_run_id>/annotations?per_page=100" \
  | python3 -c "import json,sys
for a in json.load(sys.stdin):
    lvl = a.get('annotation_level') or a.get('level')
    print('==', lvl, '|', a.get('title',''))
    print(a.get('message','')[:2000])"
```

**坑与纪律**：
- 级别字段名是 **`annotation_level`**（`level` 是错的——实测 KeyError）。
- **必须 `curl + python3` 原文解析，禁止用 WebFetch 的摘要结论做诊断**——摘要模型会失真（实测把 `mssql.conformance.test.ts (11 tests)` 误读成「全部 11 个测试被跳过」，差点把 beforeAll 失败误判成 skip 行为）。
- `per_page=100` 必带（默认页小；注记上限 50 条，本仓库分块输出 150 行/25 行 ≈ 7 条，够用）。
- artifact `vitest-output`（完整日志）下载需要凭据，匿名拿不到——注记已够用时不必碰。
- 匿名 API 限额 60 req/h，不要循环轮询；rerun/取消 run 需要凭据，匿名通道只读。

## 本仓库症状速查表（vitest / 契约）

| 注记特征 | 含义 | 下一步 |
|---|---|---|
| 套件 N 个测试**全部 skipped** + 套件级 Error | **beforeAll 失败的特征签名**（fixture/建连阶段炸了，测试体根本没跑） | 看 Error 是建连（E_CONN 类）还是 fixture 语句（如绑定/转换错） |
| `Test timed out in 5000ms` | vitest 默认 testTimeout 超时 | 不一定是死锁：先查阻塞链（如 A 等 B 的锁、B 等 A 的返回） |
| `- [组名] 检查名: 错误`（logFailures 格式） | 契约套件 check 级失败详情，直接给到断言层 | 按组名定位契约组与驱动文件 |
| `Test Files 1 failed \| 74 passed` | 仅特定套件失败，其余全绿 | 聚焦该套件，不必全量怀疑 |
| 「契约组失败 N 项」+ 逐项列表 | 契约组内多项检查失败 | 注意各项可能是同根因（同一份 fixture/绑定路径） |
| `Process completed with exit code 1` | 收尾行，无信息量 | 忽略 |
| Node.js 20 deprecated / ubuntu-latest 迁移 / vitest 第三参弃用 | 平台/工具噪声 | 忽略（非本次失败原因） |
| release run 挂在「测试」但后续打包/发布全 skipped | 门禁自守卫生效 | **无 VSIX 产出**——修复后重打 tag 即可，不会有半成品发布 |

## 已知案例（供类比）

- **契约 CI 首跑失败逐层暴露**（2026-10-11，v0.2.0~v0.2.1）：三轮「红→修→更深一层红」，每轮修完套件跑进更深一层。教训沉淀在 AGENTS.md 的 driver-mssql 锚点行（裸 null→NVarChar 推断、IDENTITY 显式值、锁式 RC vs MVCC、tedious decimal Number 返回、TDS 无名列空串）——排查 mssql 契约失败先读那里。
- **release 假绿**：release.yml 与 ci.yml 的 service 矩阵必须同步维护——新增契约 service 只加 ci.yml 会让发布门禁整组 skip（假绿通过）。排查「CI 红 Release 绿」先 diff 两个 workflow 的 services 与测试 env。
