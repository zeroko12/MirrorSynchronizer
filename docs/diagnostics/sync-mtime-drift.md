# Post-mortem: mapping rule 每次 sync 无意义 re-copy

**Date:** 2026-07-09
**Investigator:** Claude (diagnosing-bugs)
**Symptom (user report):** "上机测试发现有时候无法同步" (UI-driven, intermittent)

## TL;DR

[`src/core/syncer.ts`](../../src/core/syncer.ts) 中映射规则的 `applyMapping()` 用 `fs.copyFile` + `fs.utimes(Date.now())` 强制 target mtime 为"现在",**从不保留源 mtime,也不做 mtime 短路**。每一次 sync 都把 `overwrite=true` 的映射规则重新写一遍。目标文件被防病毒扫描 / 用户编辑 / 沙盒占用时,这条 re-copy 触发 EBUSY,UI 弹 warning,看上去就是"这次同步失败"。

修复:
- `fs.copyFile(src, dst)` → `fs.copyFile(src, dst, fs.constants.COPYFILE_PRESERVE_TIMESTAMPS)` —— target mtime 落 source mtime
- 在 `applyMapping` 的 overwrite 路径加 mtime+size 短路(跟镜像同步一致的契约)
- 删除多余的 `fs.utimes(targetPath, new Date(), new Date())`

## Timeline

| Step | Finding |
|---|---|
| 反馈 | 用户在 UI 上跑同步,间歇性失败。光凭描述没有 red-capable command |
| 决策 | 走 diagnosing-bugs。建 fuzz harness,跑 100 轮随机 fixture × 3 applyModes |
| 第一次红 | fuzz harness 里 `Cannot read properties of undefined (reading 'split')` —— 后来发现是我自己 helper 的 bug,不是 syncer。修了之后 fuzz 100 轮全绿 |
| 缩小范围 | 直接写一个 isolation test: 1 个 mapping(`overwrite=true`) + immediate 模式,第一次 sync 后等 50ms 第二次 sync |
| 现象 | 日志两次都打印 `[mapping] app-config: 已拷贝到`,第二次的 `result.mappingCopied = ["app-config"]` |
| 验证 root cause | syncer.ts L760-762 旧实现: `copyFile(...)` + `utimes(..., new Date(), new Date())` — 没保留 mtime,也没短路 |

## Hypotheses triaged

| # | Hypothesis | 验证方式 | 结果 |
|---|---|---|---|
| **H1** | mapping 规则没保留 mtime + 无短路 → 每次无意义 re-copy | [tests/mapping-mtime-bug.test.ts](../../tests/mapping-mtime-bug.test.ts) | **🔴 真 bug,已修复** |
| H2 | staging marker 写漏,target orphan 永远留 | [tests/h2-staging-orphan.test.ts](../../tests/h2-staging-orphan.test.ts) | 🟢 设计正确 |
| H3 | `applyMappingsOnly` 写盘位置与镜像 delete 集合不一致 | [tests/h3-applymappingsonly.test.ts](../../tests/h3-applymappingsonly.test.ts) | 🟢 设计正确(staging 写 stagingDir 是预期) |
| H4 | `dryRun=true` 也会写真实 mapping | [tests/h4-dryrun-mapping.test.ts](../../tests/h4-dryrun-mapping.test.ts) | 🟢 设计(注释 [syncer.ts:578-579](../../src/core/syncer.ts#L578-L579) 明说) |

## Why intermittent

- 同步间隔 5 分钟时,source mtime 跟 target mtime 的差距(~5min+)远超 tolerance(2ms),所以**第一轮就一定 re-copy**
- 用户在编辑 target / 防病毒扫描 / 沙盒挂起 → re-copy 触发 EBUSY → `mappingFailed` push → UI toast
- 不在以上场景时,re-copy 静默成功,用户感知不到 bug

## Architecture lesson — 防止下次再撞这种坑

**`mirror sync` 和 `mapping rule` 用两套独立代码路径处理 mtime:**

| 路径 | 保留源 mtime? | 有 mtime 短路? |
|---|---|---|
| 镜像同步(`copyFromAdapter → streamToFile(file.mtimeMs)`) | ✅ | ✅(syncer.ts L455-457) |
| 映射规则(`applyMapping → fs.copyFile + utimes(Date.now())`,旧实现) | ❌ | ❌ |

**修复让两边走同一份契约:** target mtime == source mtime(在 tolerance 内)+ size 一致 → 跳过。

**但是**:`copyFromAdapter` 和 `applyMapping` 仍然各自 stat、各自 mtime 比对。长期看,如果有第三条(更复杂)同步路径,这种"两套独立实现"会再次漂移。更稳的架构是把 mtime+size 比较提成一个 helper:

```ts
// 提议(下次重构时再做):
function sameContent(a: FileEntry, bSize: number, bMtimeMs: number): boolean {
  return a.size === bSize && Math.abs(a.mtimeMs - bMtimeMs) <= MTIME_JITTER_TOLERANCE_MS;
}
```

镜像同步和映射规则都调它,contract 单一真相源。

## What / Why / How to apply

**Why:** 当一个 codebase 里有多个"看起来相似但又各自实现"的 IO 路径时,容易出现"它们各自有不同 bug"的现象。诊断这种 case 时,**先比对"等价路径"的等价步骤**——这次我读 syncer.ts 时刚好注意到镜像走 `streamToFile(file.mtimeMs)` 而映射走 `utimes(Date.now())`,才触发了 isolation test。

**How to apply:**
- 任何时候看见"两段相似代码"先怀疑 — 它们可能各有各的 bug
- 写"等价路径比对"作为 sanity check:同一个 case 走两条路,断言结果一致

## Files added

| File | Purpose | Status |
|---|---|---|
| [tests/mapping-mtime-bug.test.ts](../../tests/mapping-mtime-bug.test.ts) | **永久回归**(主用例 + 控制用例) | 必留 |
| [tests/fuzz-sync.test.ts](../../tests/fuzz-sync.test.ts) | Fuzz harness,长期有效 | 可选保留 |
| [tests/h2-staging-orphan.test.ts](../../tests/h2-staging-orphan.test.ts) | Design verification (staging marker) | 设计回归,可留 |
| [tests/h3-applymappingsonly.test.ts](../../tests/h3-applymappingsonly.test.ts) | Design verification (applyMappingsOnly) | 设计回归,可留 |
| [tests/h4-dryrun-mapping.test.ts](../../tests/h4-dryrun-mapping.test.ts) | Design verification (dryRun + mapping) | 设计回归,可留 |

## Files modified

- [src/core/syncer.ts](../../src/core/syncer.ts) — applyMapping 函数:加 mtime 短路、`copyFile` 用 `COPYFILE_PRESERVE_TIMESTAMPS`、删 `utimes(Date.now())`。

## Hand-off note (next reviewer)

如要把 `applyMapping` / `copyFromAdapter` 统一成一个 mtime helper,这是 [`improve-codebase-architecture`](../) 的候选,但优先级不高 —— 现状下两条路径已经走同一份契约,下一个"+1 path"出现时再做。
