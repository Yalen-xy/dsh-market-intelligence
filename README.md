# DSH Market Intelligence

[![CI](https://github.com/Yalen-xy/dsh-market-intelligence/actions/workflows/ci.yml/badge.svg)](https://github.com/Yalen-xy/dsh-market-intelligence/actions/workflows/ci.yml)

面向 DSH Desktop 的本地只读市场信息插件，覆盖 A 股、港股、主要 A 股指数、恒生指数和恒生科技指数。它只负责获取、整理和保存行情信息，不进行估值、选股或交易。

## 下载最新版

[**⬇ 下载 Windows 安装包（ZIP）**](https://github.com/Yalen-xy/dsh-market-intelligence/releases/latest/download/dsh-market-intelligence-latest.zip)

1. 正常退出 DSH Desktop。
2. 下载并解压 ZIP。
3. 双击 `INSTALL.cmd`。
4. 阅读许可提示并按安装窗口完成操作。
5. 重新启动 DSH Desktop。

安装器会自动寻找 DSH Desktop 的受管 Profile，校验发布文件，并在修改前创建有限范围的备份。检测到相关 DSH 进程、文件校验失败或安装条件不明确时，它会停止而不是强行修改。高级安装、指定 DSH 数据目录、升级、卸载和恢复方法见[安装与恢复指南](docs/INSTALL.md)。

## 能做什么

- 查询 A 股、港股及主要指数的市场阶段、集合竞价和开市前状态。
- 获取行情快照、分钟线以及日、周、月序列。
- 获取新浪行业和概念板块观察，并在腾讯 A 股行情失败时使用新浪后备。
- 维护最多 100 只证券的本地观察列表，在开盘期间进行有界轮询。
- 使用 SQLite 保存观察数据，提供压缩、容量限制、缺口记录和恢复游标。
- 通过 `market_data_health` 明确报告延迟、陈旧、缺失和解析异常，不用虚构数据填补空白。

插件提供七个 DSH 工具：`market_auction`、`market_data_health`、`market_quotes`、`market_sectors`、`market_series`、`market_status` 和 `market_watchlist`。参数与返回字段见[工具参考](docs/TOOLS.md)。

## 工作原理

插件在 DSH Desktop 进程内运行。调度器根据中国内地和香港市场阶段控制采集频率；数据源适配器从固定、经过审查的腾讯和新浪公开端点读取信息；规范化层统一证券代码、时间和缺失值；SQLite 存储层保存行情与健康记录；七个工具只把经过状态和时效检查的数据交给 DSH。

完整的数据流、模块职责、存储限制和故障恢复设计见[架构说明](docs/ARCHITECTURE.md)。

## 明确边界

本插件不登录券商，不读取账户、持仓或交易信息，不下单，也不提供模拟交易。唯一会改变本地状态的模型可见操作是维护本插件自己的观察列表。它与 `dsh-stock-watch` 没有运行时或数据依赖。

## 要求与许可

- Windows 版 DSH Desktop，以及可用的受管 Desktop Profile。
- Windows PowerShell 5.1 或 PowerShell 7。
- Node.js `^22.19.0 || >=24.0.0`。
- 仅限个人、非商业、只读研究使用，具体见[许可证](LICENSE)。

Use is limited to personal, non-commercial, read-only research. Tencent and Sina are not partners of, and have not authorized, this project. Their unofficial interfaces may change, fail, or become unavailable without notice. You are responsible for compliance with applicable law and upstream terms. Nothing in this project or License grants third-party authorization or guarantees legal compliance.

本项目不是投资建议，不保证数据完整、准确、实时或适合交易。

## 更多资料

- [安装、升级、卸载与恢复](docs/INSTALL.md)
- [七个工具的参数和返回值](docs/TOOLS.md)
- [架构和数据流](docs/ARCHITECTURE.md)
- [安全边界和漏洞报告](SECURITY.md)
- [变更记录](CHANGELOG.md)
