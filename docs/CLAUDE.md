# Claude Desktop extension

`claude-market-intelligence-latest.mcpb` 是面向 Claude Desktop 的 Windows 扩展。它提供与 DSH 相同的七个只读行情工具，不要求安装或运行 DeepSeek Harness。安装包不需要手动执行 npm 命令或编写 JSON 配置。Claude Desktop supplies the extension runtime; normal installation needs no dependency management.

## 安装

1. 从当前 [GitHub Release](https://github.com/Yalen-xy/dsh-market-intelligence/releases/latest/download/claude-market-intelligence-latest.mcpb) 下载 `claude-market-intelligence-latest.mcpb`。
2. 打开 Claude Desktop，依次进入 **Settings → Extensions → Advanced settings → Install Extension**。
3. 选择下载的 `.mcpb` 文件并完成安装；返回扩展列表确认它已启用。
4. 在对话中调用 `market_status` 或 `market_data_health`，确认本机市场数据状态。

扩展仅支持 Windows。它不安装 DSH、不修改 DSH 配置，也不需要把 DSH 保持运行。

## 存储与配置

默认情况下，扩展在 Windows 的 Claude 专用应用数据位置保存自身的数据库、观察列表、日志、收盘配置和有界恢复状态。Claude 与 DSH 的数据库和运行状态相互独立：不会自动导入、迁移或同步观察列表和行情数据。

如需把 Claude 数据放到本地 D 盘，请在扩展设置中为 storage directory 选择绝对本地路径，例如 `D:\MarketData\ClaudeMarketIntelligence`。不要选择网络共享、可移动介质、相对路径或含重解析点的路径；不安全的路径会使扩展停止启动。请求超时、行情轮询和板块轮询可在同一设置页内调整，未配置时使用受限默认值。

## 工具

Claude 与 DSH 使用同一份工具契约，工具名和业务行为一致：

- `market_auction`：读取 A 股集合竞价或港股开市前观察值。
- `market_data_health`：查看数据源、调度器和存储健康状态。
- `market_quotes`：读取 A 股、港股和固定指数的行情快照。
- `market_sectors`：读取 A 股行业或概念板块表现。
- `market_series`：读取一个支持证券的分钟、日、周或月序列。
- `market_status`：读取 A 股与港股的交易阶段。
- `market_watchlist`：读取、添加或删除本扩展自己的本地观察列表项目。

参数、结果字段和不可用数据的表达方式见[工具参考](TOOLS.md)。`market_data_health` 是排查延迟、陈旧、数据源失败或本地存储问题的首选入口；数据缺失会明确标示，不会用猜测值补齐。

## 卸载与诊断

在 Claude Desktop 的 Extensions 列表中选择本扩展并执行 Uninstall。卸载不会修改 DSH；如需清除 Claude 的本地市场数据，请仅在确认不再需要其历史、观察列表和诊断记录后，按 Claude 显示的扩展数据管理选项操作。

如果 Claude 未列出工具，请确认系统为 Windows 且扩展处于启用状态。若工具可见但没有数据，先运行 `market_data_health`：它会区分提供方不可用、缓存陈旧、请求超时和存储故障。请不要在问题报告中附上本机路径、数据库、日志、凭据或原始上游响应。

## 边界、隐私与法律说明

扩展只读取经过审查的公开行情端点；不登录证券账户，不读取账户、持仓或交易信息，不下单，也不提供实盘或模拟交易。它仅能变更自身的观察列表、配置、数据库、日志和有界恢复状态。腾讯到新浪的后备仅用于既定能力和端点策略，不能保证数据可用性、准确性、及时性或连续性。

请分别阅读[腾讯隐私政策](https://www.tencent.com/privacy-policy/)与[新浪隐私政策](https://corp.sina.com.cn/eng/sina_priv_eng.htm)。本项目及其输出仅供信息与研究参考，**不构成投资建议**，也不构成证券或金融产品的要约、招揽、推荐或保证。

Use is limited to personal, non-commercial, read-only research. Tencent and Sina are not partners of, and have not authorized, this project. Their unofficial interfaces may change, fail, or become unavailable without notice. You are responsible for compliance with applicable law and upstream terms. Nothing in this project or License grants third-party authorization or guarantees legal compliance.
