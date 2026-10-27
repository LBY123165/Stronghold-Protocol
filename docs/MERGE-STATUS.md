# 上游 v0.3.3 合并状态说明

> 记录时间：2026-10-27
> 分支：`capacity-0.3.1`（20 人容量分支）
> 合并对象：官方上游 v0.3.3 快照（sganggs 发布包，2026-10-25）

---

## 一、一句话结论

上游 v0.3.3 **已经并入分支并完成了主体收尾**：20 个提交、950 个文件改动，golden 全量 288/288 对齐上游，类型检查零错误，分支独有能力（20 人容量、等待室聊天、OneBot 群招募、带宽紧急保护、分组卡池、紧凑线路编码等）已逐项接回。

当前卡在**收尾阶段**：压测回归已定位并修复（见第六章），工作区的广播编码优化与三处调试探针已清理并拆成两个提交落库。剩余工作集中在上游 0.3.3 新增测试文件所需的运行环境上。

---

## 二、合并背景

| 项 | 值 |
|---|---|
| 分支合并前 HEAD | `ea5a4dcd`（OneBot 群招募说明与 Nginx 反向 WS 模板） |
| 上游 v0.3.3 快照 | `e0c5f53e` |
| 合并提交 | `46cb66f9` |
| 上游快照相对分支基线的差异 | 1188 files changed, +121056 / −50180 |
| 合并后分支相对基线的累计差异 | 950 files changed, +119330 / −9536 |
| 合并后提交数（`ea5a4dcd..HEAD`） | 20 |
| 测试文件总数 | 1102 |

### 冲突性质

上游 `MAX_SEATS = 4`，分支 `MAX_SEATS = 20`（`ROOM_CAPACITIES = [4,8,10,16,20]`）。**容量层以分支为准**，上游的容量相关改动全部不采纳。

上游 0.3.3 相对 0.3.1 的大规模改动是**战斗结算重构**：`server/sim/damage.js`（669 行）拆分为 `server/sim/attack.js` + `server/sim/attack/{calculation,effects,element,heal,health,helpers,hit,legacy,transfer}.js`（887 行）。这是规则层改动，风险最高，因此合并后单独安排了一次 golden 全量重跑。

上游还带来了一整批新能力：多版本支持、战斗结算重构、AI 体系（`server/ai/*` 8 个模块 + `server/match/` 13 个模块）、观战席 AI 接管（`server/aiTakeover.js`，与分支的断线接替投票 `server/match/match/takeover.js` 是两套并存机制）、Worker 池与 state delta 传输、盟约计时器、CI 分片工具链。

---

## 三、已完成的工作

### 3.1 提交清单（20 个）

**合并本体**
- `e0c5f53e` — 官方上游 v0.3.3 快照
- `46cb66f9` — merge: 并入官方上游 v0.3.3

**分支能力接回（语义层）**
- `478a71da` — 补回合并中丢失的本分支能力接线
- `8a365b5e` — 补回选牌顺序、调度器转发与盟约计划的分支语义
- `290be021` — 修正 union 造成的语义错配
- `bb52d8c5` — 补回带宽紧急保护的接线与同步心跳
- `9e0529e8` — 恢复机变选牌的分组语义与紧凑线路协商
- `677f36ed` — 修正分组卡池的接口与装备债务归属（20 人对局不变量）
- `efb79c4b` — 恢复抽卡助手丢失的盟约过滤（golden 全量对齐上游 0.3.3）
- `456edd13` — 去掉选牌阶段混入上游单组逻辑的多余洗牌

**前端与运维（接线层）**
- `5126a2d7` — 补回前端房间容量、等待室聊天与群招募，并让尺寸底线参与 UI 缩放
- `bcf7ac74` — 补回房间容量继承、目录限流与默认版本守卫
- `cb0b34d3` — 预览的抽卡助手不再消耗对局的活随机流
- `7ba6a97a` — 补回合并丢失的前端接线与抽卡助手的库存语义

**规则与守卫**
- `94c970f6` — 给三个循环标注上限（loop-cap 守卫）
- `3a01c441` — 恢复被合并工具清空的六个文档
- `db767fa7` — 去掉导入守卫里多余的 `nodeData.js` 豁免

**测试适配（上游 0.3.3 语义，用例写于 0.3.1 时代）**
- `bb9915cb` — 让上游用例反映分支的容量与选牌语义
- `61caae8f` — 修回网络与 HTTP 层被合并改动打断的行为
- `c4039c17` — 让紧急保护的心跳用例跟上上游的分片心跳

### 3.2 关键修复详解

#### 3.2.1 golden 阻塞项（`efb79c4b`）

分支与上游 0.3.3 的 `test/golden/matches.json` 有 6 个场景差异。三方比对定位：

- 上游 0.3.1 golden vs 分支 golden → 只差 3 个（全是含真人的场景）= 分支特性（固定组独立卡池 + 真人优先选牌）的预期差异
- 上游 0.3.3 golden vs 合并后 golden → 差 6 个，其中 5 个是**纯 bot 场景** → 与分支特性无关，是合并引入的偏差

**根因**：`81d415e5`（P2-P5 容量层移植到 v0.3.1）把
`server/match/effectsMeta.js` 的 `m.pool.roll(rng, { ..., filter: f, ... })`
改成 `ps.pool.roll(m.rngMeta, { ..., filter: <只含 opts.filter> })`，
**误丢了 `filter: f` 里的 `opts.bond` 过滤**。

`opts.bond` 有真实调用点（`server/sim/content/choices.js:264` 的 bondChess 奖励、`server/sim/content/garrisons/meta.js:342` 的盟约干员抽取）。丢失后抽取范围从「该盟约的干员」变成「任意干员」，RNG 序列随之偏移。

**注意**：`67879bc1` 那次「重算 golden（21 个对局场景）」是**基于这个有缺陷的 rollChess** 重算的，把 bug 固化进了 golden 文件。

**修复**：`rollChess` 恢复 `filter: f`（含 bond 过滤），同时保留分支的 `ps.pool`（分组卡池）与 `rolls.rngMeta`（预览不消耗活随机流）。修复后 **golden 288/288 全量匹配**（roster 49 / bonds 46 / fields 22 / matches 21 / standins 10 / diy 140）。

#### 3.2.2 分组卡池的三处移植遗漏（`677f36ed`）

分支 `81d415e5` 引入分组卡池时漏了三处，20 人局会跑错：

1. `server/match/player/items.js` 的 `releaseItemStock` 读 `this.m.itemPool`（第一组的兼容池）还债，而持有量与上限算在座位自己的组池 → 第 2~5 组销毁装备时把债务还到别人头上，报 `item chess_item_1_01_e_a: held 5 > cap 4 without debt 0`。改为 `itemPoolFor(this)`。
2. `server/match/Match.js` 的 `m.pool` 换成访问器：赋值时同步指向旧池的分组与座位（`poolGroups` / `playerPools` 保持自身身份，容量测试对它们断言身份不变）。上游把 `m.pool` 当唯一真源，其 `poolOf` 直接读它；分支的 `poolFor` 走 `playerPools`。
3. `server/match/effectsMeta.js` 的 `rollChess` 忽略 `opts.ignoreCounts`。

#### 3.2.3 网络与 HTTP 层（`61caae8f`）

四项合并遗留，均已定位到具体改动：

| # | 文件 | 问题 | 处理 |
|---|---|---|---|
| 1 | `server/http/static.js` | `createStaticHandler` 的 `runtimeCache = false` 默认值覆盖了 `RuntimeCache` 自己的默认（`enabled = process.env.SP_HTTP_RUNTIME_CACHE !== '0'`）。调用方不传该参数时 `?rv=` 的 URL 不再校验、生成的 HTML 退回 size-mtime ETag、Brotli 与条件请求语义全变 | 默认值改回 `undefined`，交给 `RuntimeCache` 决定 |
| 2 | `server/net.js` | 合并时给 `heartbeat()` 加了「≤128 个连接走同步路径」的捷径。上游语义是**永远走分片的异步 pass**（`_heartbeatPending` 立即为 true，少于一个分块的连接集也在同一 tick 内跑完） | 去掉捷径，恢复上游语义 |
| 3 | `server/net.js` | `_heartbeatConn` 读 `this.emergency.active` 时，`this.emergency` 在直接用 `Network.prototype` 的单元测试里是 undefined | 对缺失字段做保护 |
| 4 | `server/match/match/messaging.js` | `toast` 的 `canReceive`（分支的接管席位能力，语义比上游的 `ps.connected` 更宽）在消息层单元测试直接调原型方法时不存在 | 缺失时退回普通检查 |
| 5 | `server/lobby.js` | `matchSend` / `matchBroadcast` 直接 `ctx.chat.clear()`，而等待室聊天让 `ctx` 多了一个字段 | `?.` 保护 |

#### 3.2.4 测试适配（语义随上游演进，用例需要跟上）

- `test/versions-default-guard.test.js` — 等待室聊天的随机 id 纳入 `normaliseState` 规范化
- `test/match/group-stock.test.js` — `rollChess` 的 `ignoreCounts` 恢复后，拟态物质（无视库存抽身份）能抽到 over-draw 的干员，与上游 0.3.3 一致；旧的「over-draw 的干员抽不到」断言过时
- `test/test-mode.test.js` — 加入房间后最后一条消息可能是 `m.chatState`（等待室聊天），改为在 `room.state` 上断言 `test` 标记
- `test/runtime-http.test.js` — `?v=` 是上游 0.3.3 引入的版本 pin 机制，`immutable` 是正确语义，旧断言期望 `no-cache` 已过时
- `test/emergency-network.test.js` — 上游心跳是分片的异步 pass，同一 tick 内第二次调用会被 `_heartbeatPending` 跳过；用例改为 `await` 一个 tick，与上游 `test/net-heartbeat-chunked.test.js` 的 settle 同一手法

#### 3.2.5 导入守卫（`db767fa7`）

合并时给 `tools/check-imports.mjs` 加了一段豁免：`server/sim/nodeData.js` 的 Node 内建模块被记成 note（允许）。上游 0.3.3 没有这段豁免，分支与上游的 `test/check-imports.test.js` 也一致地期望它们是**违规**（`server/sim/nodeData.js:11: node:fs [sim-node]`）—— sim 边界上的 Node 用例正是这个守卫要显式列出来的东西。删掉豁免。

### 3.3 质量门禁现状

| 门禁 | 结果 |
|---|---|
| golden 全量 | **288/288 通过** |
| TypeScript 检查（`tsc --noEmit --checkJs -p jsconfig.json`） | **0 错误** |
| 导入守卫（`test/check-imports.test.js`） | 4/4 通过 |
| 部署资产（`test/deploy-assets.test.js`） | 11/11 通过 |
| 公告 CLI（`test/announcements-cli.test.js`） | 4/4 通过 |
| 网络心跳（`test/net-heartbeat-chunked.test.js`） | 8/8 通过 |
| 测试房 + i18n（`test/test-mode.test.js` + `test/i18n-server.test.js`） | 47/47 通过 |
| 分组卡池（`test/match/group-stock.test.js`） | 7/7 通过 |
| HTTP 运行时（`test/runtime-http.test.js`） | 7/7 通过 |

---

## 四、工作区改动（已处理）

工作区的 5 个改动文件已全部处理完毕，拆成两个提交落库。

### 4.1 广播编码优化（已提交 `5e2d0edc`）

**问题**：上游 0.3.3 为了 state delta（每个连接有自己的基线），把广播的「编码一次共享给所有连接」改成了「每个连接各自处理」——`sendRaw` 里每个连接都要 `JSON.parse(data)` + `encodeWire(...)`。84 个连接时，同一帧的 CPU 开销是 84 倍。

**改动**：

`server/net.js`
- `sendRaw(ws, data, { droppable, compact })` — 新增 `compact` 参数：广播已经算好的 wire 紧凑格式时直接复用，不再逐连接重编码
- `send(ws, msg, encoded, prepared)` — 新增 `prepared` 参数（`prepareMessage` 的产物，含 `json` 与惰性的 `compact` getter）；区分两条路径：
  - 协商了 delta 的连接且消息属于 `DELTA_KINDS` → 走 delta 传输层自己的 `m.state` 帧（JSON，不转 wire）
  - 其余连接 → 走广播共享的 compact 帧
- `sendSession(session, msg, encoded, prepared)` — 透传 `prepared`
- import 增加 `stateDeltaVersion`、`DELTA_KINDS`

`server/lobby.js`
- `broadcastRoom` / `broadcastState` / `sendToPlayer` — 改用 `prepareMessage` 一次编码，把 compact 帧共享给所有接收方

**状态**：已验证「每连接重编码」计数归零，压缩比正常，压测通过（见第六章）。

### 4.2 调试探针（已清理）

| 文件 | 探针 | 处理 |
|---|---|---|
| `server/net.js` | `SP_DBG_SEND` 块（在 `send` 函数内，统计 delta/wire/prepared） | 已整段删除 |
| `test/helpers/wsClient.js` | `SP_WP_PROBE` 块（统计 `wire:<id>` / `json:<t>` 帧类型分布） | 已整段删除 |
| `test/wire-pressure.test.js` | `console.error('[wp] 帧类型 ...')` 一行 | 已删除 |

### 4.3 提交顺序

原先「压测仍红故暂不提交」的理由已失效——根因既不在工作区改动，也不在广播路径，而是上游的压缩窗口参数（见第六章）。因此两个提交按主题拆分：

1. `f47149b3` — 压缩窗口修复（根因，独立提交）
2. `5e2d0edc` — 广播编码优化（性能，独立提交）

---

## 五、测试现状

### 5.1 分片结果（`tools/ci-shards.mjs`，4 分片）

| 分片 | tests | pass | fail |
|---|---|---|---|
| 0 | 2637 | 2605 | 2 → **1**（装 Pillow 后） |
| 1 | 2550 | 2494 | 19 → **1** |
| 2 | 2935 | 2881 | 21 → **0** |
| 3 | 2885 | 2800 | 56 → **28**（并发）/ **23**（串行） |
| **合计** | **11007** | **10756** | **122 → 约 30** |

失败数从 122 降到约 30，剩余项已逐条定位（见 5.2），全部为环境或上游自身问题。

### 5.2 失败归因（更新）

| 类别 | 数量 | 说明 |
|---|---|---|
| 沙箱删除保护（环境噪声） | **24** | `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（`scope: "turn"`，count 50 / threshold 50）—— WorkBuddy 环境的删除保护在单轮内累计到 50 次 `fs.rmSync` 后开始拦截。**逐文件串行跑全部通过**（`test/plugins/forgeImport.test.js` 单独跑 47/47） |
| 缺失 Python 依赖（环境缺口） | **1** | `test/version-assets.test.js` 需要 `PIL`；Pillow 是项目已声明的依赖（`tools/local-extract/requirements.txt`），但本机 Python 未装。**装上 Pillow 后通过（6/6）** |
| 上游自身的素材缺陷 | **3** | `test/assets.test.js`：清单里的文件不在磁盘上（`char_109_fmout.atlas`）、atlas 的 `pma` 标记缺失。**已复核上游工作树有完全相同的缺陷**（同样缺 `char_109_fmout`、同样无 `pma`），且 `data/assets.json` 与上游逐字节相同 |
| 并发竞态（伪失败） | **2** | `test/official-tables.test.js` 的 studio CLI 用例（并发下 500，串行 17/17 通过）、`test/match/external-transports.test.js` 的 stdio 超时用例（并发下失败，串行连跑 3 次均 16/16 通过） |

### 5.3 并发假说（已证实）

首次全量并发跑出 126~130 项失败。**串行跑（`--test-concurrency=1`）同样的文件列表只掉到 55 项**，其中 38 项仍是 safe-delete 环境拦截，真实失败只有约 14 项。

结论：并发跑时 `test/match/*.test.js` 的失败集中在子进程宿主类 → **并发资源竞争，不是逻辑问题**。

后续排查统一采用串行口径。

### 5.4 真实失败的构成（更新）

原报告里「91 项真实失败，绝大部分集中在上游 0.3.3 新增测试文件、分支缺少对应运行环境」这一判断**不成立**。逐条复跑后：那批上游新增测试文件（`ai-takeover` / `build` / `ci` / `ci-shards` 等）在分支上**全部通过**——上游需要的 `tools/` 目录本来就已随合并引入，无需额外补齐工具链。

真正剩下的只有上表四类，均已定性。

### 5.5 归因方法（沉淀，重要）

上游 0.3.3 新增了 184 个测试文件（多为历史版本 golden，以及 studio / forge / plugins / match-host / sandbox / trusted / advisor 一整套工具链测试）。这些用例依赖上游自带的一批工具（`tools/` 下的 CLI、SDK、SES 沙箱、match host 子进程等），分支没有把它们一并引入，因此大面积失败。

清单中占比最大的一批即属此类，典型如：
- `match hosts (P1c): ...` / `match hosts in rooms (P1c): verification, the watchdog, crashes`
- `production match host and an isolated browser module tree agree`
- `trusted activate routes, immutable lobby copies and health run in a child`
- `sandbox catalogue, constrained preflight, no pin/public gate, real room needs no consent`
- `advisor stdio: one hello shared by seats, one prep call per round and real IO`
- `trial child: vanilla and plugin repeated bit for bit...`
- `Forge import: theme-only, variables beside a panel, and notices`
- `synthetic new hook imports as a validated content product`

**（3）分支自身遗留**

| 用例 | 状态 |
|---|---|
| `84 compact sockets in four rooms retain control/resync at 0.8 Mbps application budget plus cold HTTP` | **已解决**（根因见第六章，提交 `f47149b3`） |
| `CLI publish/list/pin/unpin persist across independent processes...` 等 4 项 CLI 用例 | 偶发超时（冷启动 + 沙箱扫描），复跑 4/4 通过 |
| `repeated protected heartbeats keep the oldest unanswered ping as recovery evidence` | 已由 `c4039c17` 修复 |

### 5.5 归因方法（沉淀，重要）

失败归属必须用**同口径**比较：同一个文件列表、同一份素材（给上游工作树做 `public/assets` 的 Junction 联接）、同一并发度。差集比较只在同口径下有意义。

具体做法：
1. **三方比对隔离** — 上游 0.3.1 golden vs 分支 golden（战斗代码未变，差异 = 分支特性）vs 上游 0.3.3 golden vs 合并后 golden（差异 = 分支特性在新代码下的残留）
2. **提交级二分** — `git checkout <commit>` 跑目标用例；**必须区分 CRASH / MATCH / DIFFER**（合并提交当时因 `platform.js` dispose 崩溃，无 MISMATCH 输出会被误判为 ALL-MATCH）
3. **文件级二分** — 逐个把文件还原为上游版本，看哪个恢复 ALL-MATCH
4. **语义探针** — 单项恢复某个参数/字段，逐一验证
5. **串行口径** — 排除并发资源竞争的假失败

---

## 六、未解决问题：wire-pressure 压测回归

### 6.1 现象

`test/wire-pressure.test.js`（**分支独有**，上游 0.3.3 无此文件）：84 个连接、4 个房间、0.8 Mbps 应用层带宽预算，每 200ms 广播一次合成的 `m.public` 视图，等第 39 个 tick 的帧送达。

- 合并前（`ea5a4dcd`）：**通过**，14 秒
- 合并后：**失败**，客户端只收到 11/40 个合成帧（合并前 37/40）

失败点是 `await Promise.all(clients.map((c) => c.waitFor('m.public', (m) => m.serverNow === stamp + 39, 8000)))` 超时。

### 6.2 排查方法

按「先排除并发 → 再排除环境 → 再三方比对 → 最后才二分」的顺序重查，并加了两项关键量化手段：

1. **同口径诊断**：在合并前的工作树（`ea5a4dcd`）跑同一份诊断脚本，按 tick 记录每个客户端收到的合成帧数、socket 累计字节、代理队列水位。
2. **逐帧类型统计**：在客户端按帧类型统计数量与字节，得到两版可直接相减的对照表。

### 6.3 根因（已确认并修复）

**上游 v0.3.3 把 WebSocket 服务端 deflate 窗口从 15 位（32 KiB）改成了 13 位（8 KiB）。**

该取舍是按**四人局**标定的：四人局一次 `m.public` 小于 8 KiB，整帧装得进字典，跨帧增量压缩照常生效。而本分支一房 **20 人**，一次 `m.public` 约 20 KB 文本 —— 8 KiB 窗口装不下一整帧，保留的字典只能从帧中间重建，20 人房赖以省带宽的跨帧增量压缩因此失效。

量化对照（同一压测场景，同口径）：

| | 帧数 | 解压后字节 | 线上（socket）字节 | 代理峰值队列 | 合成帧送达 |
|---|---:|---:|---:|---:|---:|
| 合并前 `ea5a4dcd`（15 位） | 3276 | 64,668,240 | 696,234 | 331 KB | 31–37 / 40 |
| 合并后（13 位） | 3276 | 64,668,240 | **3,215,180** | **2.7 MB** | **5–11 / 40** |
| 合并后（改回 15 位） | 3276 | 64,668,240 | 626,650 | 290 KB | 29–38 / 40 |

关键点：**两版发送的帧数与解压后字节完全相同**，差异只在压缩后的大小。0.8 Mbps 的共享出口在 8 秒内放不完 3.2 MB，代理队列堆到 2.7 MB，合成帧只送达前 5–11 个 —— 与观察到的「tick 11 之后送达中断」完全吻合。

只把 `serverMaxWindowBits` 从 13 改回 15、其余不动，压测即由超时转为通过。

**归属**：这是**容量层冲突**，与 `MAX_SEATS = 4 → 20` 同一类——上游的参数按四人局标定，在 20 人房不再成立。按分支既有规则（容量层以分支为准），服务端窗口回到 15 位。

### 6.4 修复与验证

`server/http/websocket.js`：

```js
export const WS_DEFLATE = Object.freeze({
  threshold: 1024,
  clientNoContextTakeover: true,
  serverMaxWindowBits: 15, concurrencyLimit: 4,
  zlibDeflateOptions: Object.freeze({ level: 6, memLevel: 7 }),
});
```

- 保留上游 0.3.3 的**发送端阈值**机制（`applySendThreshold`）。上游不再依赖 ws 自带的 `threshold`（ws 只在协商出 `*_no_context_takeover` 时才套用自己的阈值），阈值改为在发送点按 UTF-8 字节长度决定；这一层与窗口位数无关，故照留。
- **不**显式写 `serverNoContextTakeover: false`。ws 在该值**严格**为 `false` 时会拒绝一切带 `server_no_context_takeover` 的客户端提议（握手 400），而上游的压缩用例恰恰要求这类客户端能连上并「得不到省字节的好处」。省略该字段即交由 ws 默认值处理——这是本次修复中唯一被上游用例挡住而需要调整的地方。
- `clientNoContextTakeover: true`：入站不保留上下文，每条连接只占一份字典状态。

同步修正的文档：
- `docs/design/network.md` 的 §8 此前有**两段互相矛盾的 Transport 段落**（合并工具把分支旧段与上游新段并列保留），已合并为一段并写明 15 位窗口的容量层理由。
- `docs/WIRE_PROTOCOL.md` 第 99 行原本就写着「服务端保留 15 位窗口（32 KiB 字典）……全局压缩并发上限 4」——修复让代码回到文档已声明的状态，该文档无需改动。
- `test/ws-compression.test.js` 的文件头注释与用例名仍写「8 KB server window」，已更新。

**验证**：
- `node --test test/wire-pressure.test.js`：通过，84 sockets：JSON 150,000,480 B → WS 735,144 B，p95 ping 1426.7 ms（共享 0.8 Mbps）
- `node --test test/ws-compression.test.js`：9/9 通过
- 网络相关五件套（`net-heartbeat-chunked` / `ws-compression` / `wire-pressure` / `runtime-http` / `emergency-network`）：31/31 通过
- `node --test test/docs-consistency.test.js test/docs-paths.test.js`：32/32 通过
- `tsc --noEmit --checkJs`：0 错误

### 6.5 已排除的假设（存档）

| 假设 | 结论 |
|---|---|
| 帧变大 | **排除**。两版帧数、解压后字节完全一致（3276 帧 / 64,668,240 B） |
| 压缩失效 | **排除**。压缩确实在生效，只是**压缩率**变了：13 位窗口装不下 20 KB 的整帧，跨帧增量失效 |
| 编码 CPU 瓶颈 | **排除**。每连接重编码已优化掉，压缩比恢复到正常值，压测仍失败；且把工作区改动暂存后失败依旧 —— 回归来自合并本身 |
| 带宽总量超限 | **排除（已量化）**。不是「略微超限」，而是同一批帧压缩后大了 5.1 倍（63 万 → 321 万），队列从 331 KB 涨到 2.7 MB |
| 对局阶段推进导致额外广播 | **排除**。服务端逐次计数确认广播次数与 JSON 字节数两版一致 |
| wire 协商失效 | **排除**。曾发现并修复一个真实缺陷（合并后 `broadcastRoom` 用 `encode(msg)` 使合成帧以 JSON 而非 wire 紧凑格式发出），改回 `prepareMessage` 后 wire 帧恢复；压测当时仍失败，说明这不是根因 |
| 广播次数差异 | **排除**。服务端计数两版一致 |

---

## 七、待办清单

### 已完成

1. ~~清理三处调试探针~~ —— 已清理并随两个提交落库
2. ~~决定广播编码优化改动的去留~~ —— 拆成独立提交 `5e2d0edc`
3. ~~wire-pressure 压测处理方案~~ —— 根因已定位并修复（`f47149b3`）

### 待办

4. ~~**补齐上游 0.3.3 的测试依赖工具链**~~ —— **无需补齐**。上游 `tools/` 目录本来就已随合并引入；原先归为「缺少运行环境」的那批上游新增测试文件（`ai-takeover` / `build` / `ci` / `ci-shards` 等）逐条复跑**全部通过**。见 5.4。
5. **上游自带的素材缺陷**（`test/assets.test.js` 3 项）—— 已复核上游工作树有完全相同的缺陷（缺 `char_109_fmout.atlas`、smdeer atlas 无 `pma`），且 `data/assets.json` 与上游逐字节相同。**建议向上游反馈**，本分支不局部修（本地素材不全，修了也无法验证）
6. ~~**`test/match/shared-stock.test.js`**~~ —— **已通过**（11/11），此前记为「与 `rollChess` 修复无关的既有问题」的判断不成立，现随合并一并正常
7. **本机环境补装 Pillow** —— `tools/local-extract/requirements.txt` 声明了 `Pillow>=10`，本机 Python 未装导致 `test/version-assets.test.js` 失败。已在隔离 venv 与 `python3`（PATH 上的托管解释器）中装好，该用例现通过

### 质量门禁待补

8. 四分片全量回归 → golden 全量 → 类型检查（见 5.1 与 5.3 的最新数据）

---

## 八、已沉淀的经验

### 8.1 容量层移植的三类遗漏

分支往上游移植「容量层」时反复出现三类问题，每次都在 20 人局才暴露：

1. **多池结构的归属** —— `m.pool` / `ps.pool` / `playerPools` 三层里，某个方法读了错的那一层（`releaseItemStock` 读 `this.m.itemPool` 而非 `itemPoolFor(this)`）
2. **调用点的隐式参数** —— `rollChess` 的 `filter: f` 里夹着 `opts.bond`，改写时整段丢弃，导致 RNG 序列偏移
3. **随机流分层** —— `rolls.rngMeta`（预览）与活随机流必须分开，否则预览会消耗对局的随机数

### 8.2 golden 重算的前提

golden 是**行为快照**，重算之前必须先确认当前实现是对的。`67879bc1` 这次重算基于有缺陷的 `rollChess`，把 bug 固化进了 21 个对局场景的 golden 文件里 —— 之后修复代码反而需要再重算一次。**先验证实现，再重算快照。**

### 8.3 调试顺序

1. 先排除**并发**（串行重跑一次）
2. 再排除**环境**（沙箱删除保护、素材缺失等）
3. 再用**三方比对**把差异归给「分支特性」还是「合并引入」
4. 最后才做提交级 / 文件级二分

二分时若遇到进程崩溃（CRASH），不能只看 MISMATCH 输出判定通过 —— 崩溃会让 MISMATCH 为空，从而被误判为 ALL-MATCH。

### 8.4 上游改动的三类风险

| 类别 | 典型例子 | 表现 |
|---|---|---|
| 规则层 | 战斗结算重构（`damage.js` → `attack/*`） | golden 偏差、RNG 序列偏移 |
| 传输层 | state delta 引入导致「编码一次共享」变成「每连接重编码」 | 性能塌陷（84 倍 CPU）、压测超时 |
| 语义层 | `heartbeat` 从同步改为分片异步、`?v=` 版本 pin、wire 协商条件 | 上游测试与分支测试的期望冲突，需要逐条判定哪边正确 |
| **容量层** | deflate 窗口从 15 位改为 13 位（8 KiB） | **不改变任何帧的内容**，只改变同一内容能压到多小；帧数、字节数、广播次数全部一致，只有线上字节数变了 |

判定原则：**上游的测试通常反映上游的正确语义，分支的测试反映分支的特性**。冲突时先问「这个行为是特性还是过时期望」，再决定改代码还是改测试——不能默认站代码这边。

### 8.5 容量层冲突的第四类：被容量放大的参数

除 `MAX_SEATS` 外，**传输层的参数往往按上游的默认人数标定**。本次的 deflate 窗口就是典型：上游按四人局标定（一次 `m.public` 小于 8 KiB），而本分支一房 20 人，一次 `m.public` 约 20 KB —— 窗口装不下一整帧，跨帧增量压缩直接失效。

由此得到的检查清单，合并到更宽的容量层时逐条过一遍：

| 参数 | 隐含假设 | 容量放大后的后果 |
|---|---|---|
| deflate 窗口位数 | 一帧能装进字典 | 跨帧增量压缩失效，线上字节数暴涨 |
| 压缩阈值 | 小帧不值得压缩 | 大帧占比变化后阈值判定失衡 |
| 帧大小上限 / 队列上限 | 单帧大小有界 | 大帧时队列迅速堆高 |
| 限流阈值 | 单帧的代价已知 | 大帧下每帧成本被低估 |

**这类回归最难查**，因为它不改变任何**内容**，只改变**同一内容**能压到多小。定位它的有效手段是**逐帧类型统计**（帧数 / 解压后字节 / 线上字节三项对照）：前两项一致、第三项暴涨，就说明问题在编码或压缩环节，而不在业务逻辑。

### 8.6 失败归属要用「同口径 + 逐条复跑」

原报告把 91 项失败归为「上游新增测试缺少运行环境」，听起来像是需要补一套工具链。逐条复跑后发现：**那些上游新增测试文件在分支上全部通过**——上游需要的 `tools/` 目录本来就已随合并引入。

教训：**「失败项很多」不等于「缺很多东西」**。批量失败更常见的解释是同一个环境因素在批量放大（删除保护的单轮预算、缺失的 Python 依赖、并发竞态）。归因要落到**单个失败项的根因**，而不是停在「这些用例属于某一类」的层面。

