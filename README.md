# DSH Market Intelligence

[![CI](https://github.com/Yalen-xy/dsh-market-intelligence/actions/workflows/ci.yml/badge.svg)](https://github.com/Yalen-xy/dsh-market-intelligence/actions/workflows/ci.yml)

一个为 DeepSeek Harness（DSH）设计的 A/H 股只读行情插件。

把盘面交给数据，把判断留给模型。插件持续获取、整理并保存 A 股、港股、主要 A 股指数、恒生指数与恒生科技指数行情，再通过一组稳定的工具交给 DSH 使用。它不接入账户，不执行交易；本项目及其输出均不构成投资建议。

## 安装

[下载最新版 Windows 插件安装包](https://github.com/Yalen-xy/dsh-market-intelligence/releases/latest/download/dsh-market-intelligence-latest.zip)

1. 正常退出 DeepSeek Harness。
2. 下载并解压 ZIP。
3. 双击 `INSTALL.cmd`。
4. 阅读许可提示，按安装窗口完成操作。
5. 重新启动 DeepSeek Harness。

安装器会寻找 DSH 当前使用的受管 Profile，校验发布文件，并在动手前留下可恢复的备份。遇到仍在运行的 DSH 进程、校验失败或无法确认的安装环境时，它会直接停下。指定数据目录、升级、卸载和恢复见[安装与恢复指南](docs/INSTALL.md)。

## 它提供什么

- 识别 A 股、港股及主要指数的市场阶段，包括集合竞价和开市前时段。
- 获取行情快照、分钟线与日、周、月序列。
- 获取行业和概念板块表现；腾讯 A 股行情不可用时，自动切换新浪后备源。
- 维护最多 100 只证券的本地观察列表，在开盘期间进行有界轮询。
- 用 SQLite 保存观察结果，并处理容量限制、数据压缩、缺口记录和断点恢复。
- 明确报告延迟、陈旧、缺失和解析异常。拿不到的数据就是拿不到，不用猜测填空。

对 DSH 暴露的七个工具是 `market_auction`、`market_data_health`、`market_quotes`、`market_sectors`、`market_series`、`market_status` 和 `market_watchlist`。完整参数与返回字段见[工具参考](docs/TOOLS.md)。

## 工作原理

插件运行在 DeepSeek Harness 进程内。调度器按中国内地和香港市场阶段控制采集频率；适配器从固定、经过审查的腾讯和新浪公开端点读取行情；规范化层统一证券代码、时间与缺失值；SQLite 保存行情和数据源健康记录。交给 DSH 之前，每份数据都会经过状态与时效检查。

数据流、模块边界、存储约束和故障恢复设计都在[架构说明](docs/ARCHITECTURE.md)里。

## 边界

这是只读的行情信息基础设施，不是券商客户端、交易终端或投资顾问服务。插件不登录或连接证券账户，不读取账户、持仓及交易信息，不提交订单，也不提供实盘或模拟交易功能。唯一可由模型触发的本地状态变更，是维护插件自身的观察列表。它与 `dsh-stock-watch` 没有运行时或数据依赖。

## 环境

- Windows 版 DeepSeek Harness，以及可用的受管 Profile。
- Windows PowerShell 5.1 或 PowerShell 7。
- Node.js `^22.19.0 || >=24.0.0`。

## 许可与免责声明

官方发行版仅许可用于个人、非商业、只读研究。许可证不授予修改、再分发、托管服务、商业使用或传播市场数据的权利；完整条款以[许可证](LICENSE)为准。

腾讯和新浪并非本项目的合作方，也未授权或认可本项目。插件使用的非官方接口及其数据可能随时变更、中断、延迟、失准或停止提供。本项目不保证任何数据或输出的可用性、完整性、准确性、及时性、连续性及特定用途适用性。

本项目及其输出仅供信息与研究参考，不构成投资、证券、财务、法律或其他专业建议，也不构成任何证券或金融产品的要约、招揽、推荐或保证。任何人不得将其作为交易或投资决策的唯一依据。使用者应自行核验数据，并自行负责遵守适用法律、监管要求及第三方服务条款；因使用或无法使用本项目产生的风险由使用者自行承担。

Use is limited to personal, non-commercial, read-only research. Tencent and Sina are not partners of, and have not authorized, this project. Their unofficial interfaces may change, fail, or become unavailable without notice. You are responsible for compliance with applicable law and upstream terms. Nothing in this project or License grants third-party authorization or guarantees legal compliance.

## 文档

- [安装、升级、卸载与恢复](docs/INSTALL.md)
- [七个工具的参数和返回值](docs/TOOLS.md)
- [架构和数据流](docs/ARCHITECTURE.md)
- [安全边界和漏洞报告](SECURITY.md)
- [变更记录](CHANGELOG.md)
