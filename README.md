# DSH Market Intelligence

[![CI](https://github.com/Yalen-xy/dsh-market-intelligence/actions/workflows/ci.yml/badge.svg)](https://github.com/Yalen-xy/dsh-market-intelligence/actions/workflows/ci.yml)

`dsh-market-intelligence` 是一个在 DSH Desktop 进程内运行的本地只读市场信息插件。它采集并规范化 A 股、港股、主要 A 股指数、恒生指数（`hkHSI`）和恒生科技指数（`hkHSTECH`）的公开行情观察，并通过 7 个原生 DSH 工具提供查询。

它不是交易系统：不做估值、选股、评分或投资建议，不登录券商，不读取账户/持仓，不下单，也不提供模拟下单或自动交易。唯一会改变本地状态的模型可见操作是维护本插件自己的观察列表。插件与 `dsh-stock-watch` 没有运行时或数据依赖；安装、升级或移除本插件都不应修改它。

## 功能概览

- A 股和港股交易阶段、集合竞价/开市前时段与交易日历状态。
- A/H 股票及五个固定指数的行情快照、分钟线和日/周/月序列。
- 新浪行业和概念板块观察，以及腾讯失败时的 A 股行情后备。
- 最多 100 只证券的本地观察列表与开盘期间有界轮询。
- SQLite 本地持久化、分钟/日线压缩、容量限制、停机缺口和恢复游标。
- 七个闭合 JSON Schema 的 DSH 原生工具，以及完整的数据健康诊断。
- 严格只读外部边界：不接触券商、账户、持仓或交易。

## 仓库导航

| 入口 | 内容 |
| --- | --- |
| [工具参考](docs/TOOLS.md) | 七个工具的用途、参数、示例和符号格式 |
| [架构说明](docs/ARCHITECTURE.md) | 数据流、模块职责、存储、安全和恢复设计 |
| [安全策略](SECURITY.md) | 安全边界和漏洞报告方式 |
| [变更日志](CHANGELOG.md) | 版本功能和重要变更 |
| `src/` | TypeScript 源码 |
| `lib/` | 随 npm 包发布的编译结果 |
| `test/` | 单元、集成、负载和生命周期测试 |
| `scripts/` | profile smoke 与显式 opt-in 的真实端点 smoke |

## 数据源、时效与许可限制

- 腾讯财经是行情快照、指数、分钟线和前复权 K 线的首选来源；请求限于 `web.ifzq.gtimg.cn` 与 `smartbox.gtimg.cn` 的已审查固定路径。
- 新浪财经仅作为 A 股快照后备，并提供行业和概念板块数据；请求限于 `hq.sinajs.cn`、`money.finance.sina.com.cn` 与 `vip.stock.finance.sina.com.cn` 的已审查固定路径。
- 工具结果中的 `source` 表示实际来源，`marketTime` 是市场数据所代表的时间，`fetchedAt` 是本机获取时间；`isDelayed` 和 `isStale` 分别表示已知/检测到的延迟与陈旧状态。缺失字段为 `null`，不会伪装成 0。
- 这些是可能变更、限流、延迟、停用或改变格式的公开端点。插件不承诺免费、实时、连续可用或任何固定延迟，也不保证数据完整、准确或适合交易。
- 本仓库的 `UNLICENSED` 标记以及插件代码均不授予腾讯、新浪或交易所数据的再分发/商业使用许可。使用者必须自行确认其地区、用途和数据源条款允许使用。

## 市场阶段与采集节奏

所有阶段使用 `Asia/Shanghai`。区间起点包含、终点不包含；到达收盘边界后停止高频采集并运行维护。

| 市场 | 阶段 | 时间 | 行情采集 |
| --- | --- | --- | --- |
| A 股 | 集合竞价 | 09:15–09:30 | 活跃，默认每 10 秒 |
| A 股 | 连续交易（上午） | 09:30–11:30 | 活跃，默认每 10 秒 |
| A 股 | 午休 | 11:30–13:00 | 停止 |
| A 股 | 连续交易（下午） | 13:00–15:00 | 活跃，默认每 10 秒 |
| 港股 | 开市前时段 | 09:00–09:30 | 活跃，默认每 10 秒 |
| 港股 | 连续交易（上午） | 09:30–12:00 | 活跃，默认每 10 秒 |
| 港股 | 午休 | 12:00–13:00 | 停止 |
| 港股 | 连续交易（下午） | 13:00–16:00 | 活跃，默认每 10 秒 |

行业/概念板块仅在 A 股集合竞价和连续交易阶段默认每 60 秒抓取一次，每个五分钟桶最多持久化一次。上游市场时间不前进时不会重复写入，而会进入 10、30、60、300 秒的渐进退避。HSI/HSTECH 随港股阶段采集；上证、深证和沪深 300 指数随 A 股阶段采集。`providerConcurrency` 是一个由 Tencent 与 Sina 共用、跨工具调用与 provider 方法的物理 HTTP 请求上限，不是单次批处理的局部上限。

年度休市日来自本地 `config.json`。年份键必须是四位 `YYYY`；每个 CN/HK 日期必须是属于该年份的真实、规范 `YYYY-MM-DD`，同一市场内不得重复。显式年份允许两个列表都为空，此时 `calendarConfidence` 为 `configured`；某一年完全没有显式日历时，插件只使用工作日回退规则并标为 `degraded`，这不代表法定交易日已得到确认。非法配置会在 provider、数据库和调度器启动前失败。

## 七个 DSH 工具

| 工具 | 用途 | 主要参数 |
| --- | --- | --- |
| `market_status` | 查询 A 股/港股阶段、收集状态和日历置信度 | 可选 `market: "CN" | "HK"` |
| `market_quotes` | 查询显式证券、观察列表或固定指数的规范化快照 | 可选 `symbols`（最多 100）、`refresh` |
| `market_series` | 查询一个证券的分钟/日/周/月序列 | `symbol`、`interval`；可选时间范围、`qfq`、`limit` |
| `market_sectors` | 查询新浪行业或概念板块排名 | 可选 `category`、排序、方向、`limit` |
| `market_auction` | 查询 A 股集合竞价或港股开市前观察 | `market`；可选同市场 `symbols` |
| `market_watchlist` | 获取、添加或移除本地 A/H 观察证券 | `action: get/add/remove`；变更时提供 `symbol` |
| `market_data_health` | 查询数据源、调度器、数据库、缺口与保留状态 | 无参数 |

代表性工具参数都是 JSON 对象：

```json
{
  "market_status": { "market": "CN" },
  "market_quotes": { "symbols": ["sh000001", "hkHSI", "hkHSTECH"], "refresh": false },
  "market_series": { "symbol": "sh600000", "interval": "day", "adjustment": "qfq", "limit": 120 },
  "market_sectors": { "category": "industry", "sort": "changePercent", "direction": "desc", "limit": 20 },
  "market_auction": { "market": "HK", "symbols": ["hk00700"] },
  "market_watchlist": { "action": "add", "symbol": "700.HK" },
  "market_data_health": {}
}
```

非竞价阶段调用 `market_auction` 会返回成功的领域结果（空 `items` 和原因），不是工具故障。所有成功结果必须是无损 JSON：没有 `undefined`、非有限数、`BigInt`、类实例或循环结构。

## 观察列表、存储与保留

观察列表在 A 股和港股之间合计最多 100 只证券；工具会规范化代码并确定性拒绝重复项。固定指数由插件额外采集，不占用户观察列表条目。

桌面 bundle 的默认运行目录是：

```text
D:\AI\dsh\storages\dsh-market-intelligence
```

`D:\AI\dsh-tools\bin\dsh.ps1` 会把 `DSH_HOME` 设置为 `D:\AI\dsh`。未显式配置 `storageDir` 时，插件使用 `%DSH_HOME%\storages\dsh-market-intelligence`；`DSH_HOME` 和 `storageDir` 都必须是规范化的 D 盘绝对路径，后者必须以 `dsh-market-intelligence` 作为最终目录名。该目录保存：

- `config.json`：观察列表和按年度划分的 CN/HK 休市日；原子替换写入。
- `market.sqlite`（以及 SQLite 可能创建的 `-wal`/`-shm`）：行情、板块、健康和维护记录。

原始 10 秒观察只保留当前市场日。收盘维护生成一分钟和日线后，在同一事务删除已成功压缩的收盘日原始记录；一分钟数据默认保留 30 个显式存储的交易日，日线和日摘要长期保留。板块盘中数据为五分钟分辨率。维护后的软上限默认 512 MiB，优先清理最旧的证券分钟数据，再清理最旧的板块盘中数据；`config.json`、日线、日摘要和解释当前状态所需的健康记录受保护。软上限不是瞬时文件大小保证，SQLite/WAL 在维护或检查点前可能暂时更大。

DSH 停机期间不采集。插件启动时若存在上次持久化的 Tencent 尝试时间，会在 scheduler 启动前用同一旧锚点为 CN/HK 原子初始化内部 `recovery_progress` 游标（已有游标不覆盖）；此后 provider health 只用于诊断，不再充当恢复 checkpoint。每个已处理会话片段都把历史观察、该片段的 gap（如有）和推进后的游标写入同一 SQLite 事务。进程中途退出后以对应市场的 durable cursor 续跑，不会因另一个市场或即时请求更新 health 而越过尚未提交的片段；同一或更早片段的重放为 no-op，因此不同 `fetchedAt` 不会制造重复观察。恢复只处理真实交易日的有效竞价/连续交易会话，跳过午休、收盘、周末和显式休市日，最多回看 31 个日历日且最多处理 128 个会话片段。provider 只有在显式声明相应历史能力时才会收到有界回补请求；当前内置 Tencent/Sina provider 都明确声明不提供停机快照历史，因此插件不会把即时请求或序列端点冒充历史，而会为每个无法回补的会话片段幂等记录 market-wide `quote` gap，原因为 `provider_history_unavailable`。首次安装没有历史锚点时不会虚构先前缺口。

## 配置字段与边界

未知字段会被拒绝；没有 URL、请求头、Cookie、凭证或交易相关配置。

| 字段 | 默认值 | 有效范围/约束 |
| --- | ---: | --- |
| `storageDir` | `%DSH_HOME%\storages\dsh-market-intelligence`；bundle 固定为上述 D 盘路径 | 规范化 D 盘绝对路径，最终目录必须为 `dsh-market-intelligence` |
| `requestTimeoutMs` | `10000` | 整数 `100–120000` |
| `providerBatchSize` | `100` | 整数 `1–100` |
| `providerConcurrency` | `4` | 整数 `1–16`；跨并行工具调用、Tencent/Sina 与其所有物理 HTTP 请求共享 |
| `quoteIntervalMs` | `10000` | 整数 `1000–300000` |
| `sectorIntervalMs` | `60000` | 整数 `10000–900000` |
| `sectorPersistIntervalMs` | `300000` | `60000–3600000`，必须是整分钟倍数 |
| `minuteRetentionTradingDays` | `30` | 整数 `1–3650` |
| `storageSoftLimitBytes` | `536870912` | 整数 `1–536870912`（512 MiB） |
| `watchlistLimit` | `100` | 固定为 `100` |

`config.json` 的状态形状如下；优先用 `market_watchlist` 修改观察列表，手工维护休市日时应先停止 DSH 并保留备份：

```json
{
  "watchlist": ["sh600000", "hk00700"],
  "closures": {
    "2026": {
      "CN": ["2026-10-01"],
      "HK": ["2026-10-01"]
    }
  }
}
```

`closures` 只允许四位年份键，每个年份对象必须恰好包含 `CN` 和 `HK`；日期必须是规范真实日期、必须属于外层年份、同一市场内不得重复。CN 与 HK 可以在同一天同时休市，显式空数组年份也是有效配置。

## 验证、安装、升级与移除

要求 Node.js `^22.19.0 || >=24.0.0`，并需要运行时 `node:sqlite`。以下命令均从本项目目录执行；keyless 验证不会访问腾讯或新浪：

```powershell
Set-Location 'D:\AI\dsh-market-intelligence'
npm ci
npm test
npm run build
npm run test:load
npm run test:load-profile
npm pack --dry-run
```

安装或升级前必须由用户正常退出 DSH Desktop，并确认没有 DSH 所属的 Electron/Node 进程；不要自动杀进程。通过管理式 desktop profile 安装本地 checkout，不要手工编辑 profile 的 `package.json` 或 lockfile：

```powershell
& 'D:\AI\dsh-tools\bin\dsh.ps1' plugin --profile desktop add .
```

升级时先切换到已审查的目标提交，重新运行全部 keyless 验证，再重复同一个 `add .` 命令进行管理式协调。移除 bundle 也必须在 DSH 完全停止后通过管理命令完成：

```powershell
& 'D:\AI\dsh-tools\bin\dsh.ps1' plugin --profile desktop remove dsh-market-intelligence
```

移除 package 不会自动删除运行数据；备份或删除存储目录是独立、显式的用户决定。不要在本流程中删除 `dsh-stock-watch`。本机 `dsh.ps1` 固定使用 DSH Desktop 2.0.3 自带的受管 CLI `0.1.1-rc.2`，并在每次转发前核对受管 cmd、Desktop executable 与 `app.asar` 的精确路径和 SHA-256；`dsh.cmd` 只委托给这个 PowerShell 校验入口。任一身份不匹配都会失败关闭，绝不回退到 `D:\AI\deepseek-harness` 的工作区 CLI，因为两者即使带相近版本标签也可能有不兼容的核心 ABI。升级 Desktop 或恢复通道时，先保持 DSH 停止，审查新的受管通道，再同步更新 wrapper 与 `D:\AI\dsh-cli-repair\verify-desktop-channel.ps1` 中的固定路径、哈希和版本，运行该验证及本节全部 keyless gate；不要绕过管理命令直接改 profile。

## Smoke 检查

`test:load` 用假时钟和脚本化数据源模拟全部 100 只 A/H 观察列表证券以及 5 个内置指数的完整交易日，并逐证券验证原始观察压缩为分钟/日线；`test:load-profile` 使用构建后的 `lib`、真实 Cordis Context 和 ToolRuntime、临时 `DSH_HOME`，不接触用户存储，也不联网：

```powershell
npm run build
npm run test:load
npm run test:load-profile
```

真实端点 smoke 是显式 opt-in，会访问外部公开端点，结果受交易时间、网络、限流和上游格式影响。它不写 profile/数据库，只输出 provider、capability、结果状态（`ok`、`network`、`http`、`content-type`、`parse` 或 `empty`）、字节数和市场时间；每项能力都会校验相应的 Content-Type，搜索结果没有市场时间仍可为 `ok`。它不输出响应正文、错误详情、响应头、Cookie 或凭证：

```powershell
$env:DSH_MARKET_LIVE_SMOKE = '1'
npm run smoke:live
Remove-Item Env:DSH_MARKET_LIVE_SMOKE
```

不要把 `smoke:live` 放进 keyless 测试或 CI 必过条件。任一能力不是 `ok` 都会以非零状态退出；一次失败不等于市场关闭，也不能证明端点永久不可用，应结合该行的脱敏结果状态和 `market_data_health` 判断。

## 健康状态解释

- `providers[].available` 表示最近一次完整尝试是否成功；同时查看 `lastAttemptAt`、`lastSuccessAt`、`lastFailureAt` 和 `consecutiveFailures`。
- `errorCategory` 只给出脱敏类别：`timeout`、`abort`、`http`、`decode`、`parse`、`storage`、`network`、`validation`、`partial` 或 `unknown`。`partial` 表示部分结果可用，不应当作完整成功。
- `scheduler.state/pendingTimers/inFlight` 用于判断收集是否运行和是否仍有工作。停止 DSH 会停止插件、计时器和请求；本插件不会创建 Windows 服务或计划任务。
- `database.counts` 和字节数用于观察保留与容量；`retention.status=over-cap` 表示受保护数据或 SQLite 页布局使软上限暂时无法满足，`unknown` 表示还没有可解释的当前维护结果。
- `gaps` 同时记录本地原始观察压缩失败与无法由 provider 历史能力回补的停机会话区间；它们不应被解读为零成交。`reason=provider_history_unavailable` 表示当前 provider 没有明确历史能力，插件没有合成观察。
- `market_status.calendarConfidence=degraded` 表示该年份没有显式休市表，需要先补充日历再依赖阶段判断。

## 隐私与安全边界

插件只发 GET 请求，拒绝重定向，并对超时、响应体大小、批次和并发设限。它不接受任意 URL，不执行下载代码，不提交表单，不请求或存储财经网站登录 Cookie、券商凭证、账户标识、持仓或订单。日志和健康信息只保留数据源、能力、时间、状态与脱敏错误；不会保存响应正文，且应避免把完整观察列表写入日志。

## 恢复与回滚

1. 先正常退出 DSH Desktop，确认收集已经停止；复制 `config.json`、`market.sqlite`、`market.sqlite-wal` 和 `market.sqlite-shm`（若存在）作为备份。
2. 上游故障时先查看 `market_data_health`；不要把任意替代 URL 写入配置。等待恢复或发布经过审查的 provider 更新。
3. 数据库损坏时保留 `config.json`，把 SQLite 文件组移动到带时间戳的隔离目录后再启动 DSH，让插件重建数据库。新数据库没有旧 provider 健康锚点，因此不会猜测数据库丢失前的区间；插件绝不伪造行情。正常保留数据库的重启会按上述有界规则回补 provider 明确支持的历史能力，或记录 `provider_history_unavailable` gap。
4. 代码回滚时切换到先前已验收提交，重新运行 keyless 验证，然后在 DSH 停止状态下重复管理式 `add .`。不要只复制旧 `lib` 覆盖新源码。
5. 若插件无法加载且需要快速隔离，使用管理式 `remove dsh-market-intelligence`；运行数据保持不动，确认恢复方案后再决定是否清理。

DSH Desktop 停止即停止采集，这是设计边界，不是故障。如果需要常驻服务、更多市场/数据源、模型可见的新字段或任何交易能力，必须另行设计与安全审查。
