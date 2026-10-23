# 2026-10-23 盟约策略的 bond 过滤修复

## 问题

杜遥夜「广交豪杰」、佩佩「博学多通」、哈洛德「人才盲盒」和贾维「团伙行动」都承诺刷新/获得指定盟约的干员，但实际出现的是任意干员。

## 原因

`server/match/effectsMeta.js` 的 `ctx.rollChess` 按 0.3.1 的官方 golden 行为丢弃了 `opts.bond`，只把 `opts.filter` 传给卡池。四个策略通过 `bands/meta.js` 的 `rollBond(ctx, bond)` 调用它，于是 bond 条件从未进入抽取。

## 修复

`rollBond` 改为把 bond 放进 `opts.filter`：

```js
const filter = (id) => hasBond(ctx, id, bond);
ctx.rollChess({ filter, maxTier: ... });
```

四个调用点（杜遥夜、佩佩、哈洛德、贾维）共用这一处，没有改变 `ctx.rollChess` 的全局行为，避免影响其它官方 golden 场景。

## 验证

- `node --test test/content/bands.test.js`：39/39 通过（含 coverage 测试）。
- `npm run golden`：只有两个场景移动：
  - `coop3-ABYSS-5`
  - `coop2-NORMAL-14-standins`
  两者都包含上述策略的随机抽取；bond 过滤生效后，商店/meta 随机流从任意干员变为盟约干员，因而 board、layers、kills 等摘要变化。已用 `npm run golden:update` 重算并复核全部 288 个场景。
- `npm run typecheck`、ESLint 通过。

## 已知边界

`ctx.rollChess` 仍按 0.3.1 丢弃 `opts.ignoreCounts`，这是其它官方 golden 依赖的行为；本次只修 bond 过滤。炎/萨尔贡/维多利亚/叙拉古池中没有可抽取副本时，策略仍无法凭空生成干员。
