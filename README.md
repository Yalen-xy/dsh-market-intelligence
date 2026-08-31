# DSH Market Intelligence

[![CI](https://github.com/Yalen-xy/dsh-market-intelligence/actions/workflows/ci.yml/badge.svg)](https://github.com/Yalen-xy/dsh-market-intelligence/actions/workflows/ci.yml)

给 DSH 的 A/H 股只读行情层。

把盘面交给数据，把判断留给模型。插件持续获取、整理并保存 A 股、港股、主要 A 股指数、恒生指数与恒生科技指数行情，再通过一组稳定的工具交给 DSH 使用。它不碰账户，不做交易，也不替你下结论。

## 安装

[下载最新版 Windows 安装包](https://github.com/Yalen-xy/dsh-market-intelligence/releases/latest/download/dsh-market-intelligence-latest.zip)

1. 正常退出 DSH Desktop。
2. 下载并解压 ZIP。
3. 双击 `INSTALL.cmd`。
4. 阅读许可提示，按安装窗口完成操作。
5. 重新启动 DSH Desktop。

安装器会寻找 DSH Desktop 当前使用的受管 Profile，校验发布文件，并在动手前留下可恢复的备份。遇到仍在运行的 DSH 进程、校验失败或无法确认的安装环境时，它会直接停下。指定数据目录、升级、卸载和恢复见[安装与恢复指南](docs/INSTALL.md)。

## 它提供什么

- 识别 A 股、港股及主要指数的市场阶段，包括集合竞价和开市前时段。
- 获取行情快照、分钟线与日、周、月序列。
- 获取行业和概念板块表现；腾讯 A 股行情不可用时，自动切换新浪后备源。
- 维护最多 100 只证券的本地观察列表，在开盘期间进行有界轮询。
- 用 SQLite 保存观察结果，并处理容量限制、数据压缩、缺口记录和断点恢复。
- 明确报告延迟、陈旧、缺失和解析异常。拿不到的数据就是拿不到，不用猜测填空。

对 DSH 暴露的七个工具是 `market_auction`、`market_data_health`、`market_quotes`、`market_sectors`、`market_series`、`market_status` 和 `market_watchlist`。完整参数与返回字段见[工具参考](docs/TOOLS.md)。

## 工作原理

插件运行在 DSH Desktop 进程内。调度器按中国内地和香港市场阶段控制采集频率；适配器从固定、经过审查的腾讯和新浪公开端点读取行情；规范化层统一证券代码、时间与缺失值；SQLite 保存行情和数据源健康记录。交给 DSH 之前，每份数据都会经过状态与时效检查。

数据流、模块边界、存储约束和故障恢复设计都在[架构说明](docs/ARCHITECTURE.md)里。

## 边界

这是行情基础设施，不是交易终端。它不登录券商，不读取账户、持仓或交易信息，不下单，也不提供模拟交易。唯一由模型触发的本地状态变更，是维护插件自己的观察列表。它与 `dsh-stock-watch` 没有运行时或数据依赖。

## 环境与许可

- Windows 版 DSH Desktop，以及可用的受管 Desktop Profile。
- Windows PowerShell 5.1 或 PowerShell 7。
- Node.js `^22.19.0 || >=24.0.0`。
- 仅限个人、非商业、只读研究使用，具体见[许可证](LICENSE)。

Use is limited to personal, non-commercial, read-only research. Tencent and Sina are not partners of, and have not authorized, this project. Their unofficial interfaces may change, fail, or become unavailable without notice. You are responsible for compliance with applicable law and upstream terms. Nothing in this project or License grants third-party authorization or guarantees legal compliance.

本项目不构成投资建议，也不承诺数据完整、准确、实时或适合交易。

## 文档

- [安装、升级、卸载与恢复](docs/INSTALL.md)
- [七个工具的参数和返回值](docs/TOOLS.md)
- [架构和数据流](docs/ARCHITECTURE.md)
- [安全边界和漏洞报告](SECURITY.md)
- [变更记录](CHANGELOG.md)
