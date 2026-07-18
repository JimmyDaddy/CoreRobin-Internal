<div align="center">
  <img src="src/assets/brand-mark.png" width="120" alt="CoreRobin Logo" />

  <h1>CoreRobin</h1>

  <p><strong>看懂电脑状态，找到问题，安全处理。</strong></p>
  <p>一个从真实感受出发的桌面状态伙伴，让电脑变慢、风扇变响、空间不足和网络异常不再只是一堆难懂的指标。</p>

  <p>
    <a href="https://github.com/JimmyDaddy/corerobin-monitor/releases/latest"><img src="https://img.shields.io/github/v/release/JimmyDaddy/corerobin-monitor?display_name=tag&amp;style=flat-square&amp;color=6477ff" alt="Latest release" /></a>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-171a21?style=flat-square" alt="Supported platforms" />
    <img src="https://img.shields.io/badge/interface_languages-10-ff766f?style=flat-square" alt="10 interface languages" />
  </p>

  <p>
    <a href="https://github.com/JimmyDaddy/corerobin-monitor/releases/latest"><strong>下载最新版本</strong></a>
    ·
    <a href="https://monitor-app.corerobin.com/">产品网站</a>
    ·
    <a href="docs/user-guide.zh-CN.md">使用指南</a>
  </p>
</div>

<p align="center">
  <img src="docs/assets/corerobin-professional-overview.jpg" width="100%" alt="CoreRobin 专业模式资源总览与进程详情" />
</p>

<p align="center"><sub>专业模式 · 在同一屏查看系统状态、资源趋势与进程详情</sub></p>

> 截图使用内置演示数据，不包含真实设备名称、用户名、文件路径或网络信息。

应用源码与构建流程保存在当前私有仓库；官网、公开文档、Issue 和可下载 Release 统一由独立的 [corerobin-monitor](https://github.com/JimmyDaddy/corerobin-monitor) 公开仓库承载。两个仓库保持同级独立，不使用 Git submodule。发布链路与权限边界见 [Release distribution](docs/release-distribution.md)。

## 专业模式，把状态、趋势和进程放在同一屏

专业模式面向希望直接理解系统行为的用户：先给出稳定的健康判断，同时保留定位问题需要的实时指标、时间趋势与对象详情。你可以从概览继续进入进程、存储、网络、启动项和历史事件，而不必在多套工具之间切换。

- CPU、内存、交换空间、磁盘与网络实时状态
- 最近 5 分钟的资源趋势与影响最大的应用
- 进程树、应用详情、活动连接和启动项
- 网络质量、可选连接聚合、GPU 与应用能耗影响
- 重复文件、长期未修改大文件、真实登录启动影响
- 应用关注规则、历史事件、桌面提醒与恢复通知
- 主窗口、状态栏面板和 Robin 小窗口共享的后台状态

<p align="center">
  <img src="docs/assets/corerobin-professional-network.jpg" width="100%" alt="CoreRobin 专业模式网络吞吐趋势与活动连接" />
</p>

<p align="center"><sub>网络诊断 · 实时吞吐、五分钟趋势和活动连接</sub></p>

## 看清空间去了哪里

常规只读扫描会按真实文件路径整理空间占用，并用可下钻的扇形图展示目录层级；它只读取文件名、大小等元数据。另一个由用户主动开始的“重复文件”检查会读取候选文件内容并在本机计算 SHA-256。两种检查都不会上传、移动或自动删除任何东西。

<p align="center">
  <img src="docs/assets/corerobin-space-sunburst.jpg" width="100%" alt="CoreRobin 空间清理页面的完整扇形图" />
</p>

清理操作始终先加入清理篮，再明确选择“移到废纸篓”或“直接删除”。执行前还会重新检查目标；如果文件已经变化、目标无法安全确认，或涉及受保护位置，操作会直接停止。

## 日常模式，需要时快速看一眼

日常模式保留同一套监控、诊断与安全边界，但把稳定结论和最值得做的一件事放在前面。想快速确认电脑是否正常时看一眼即可，需要定位具体原因时再切回专业模式。

<p align="center">
  <img src="docs/assets/corerobin-daily-overview.jpg" width="76%" alt="CoreRobin 日常模式电脑状态概览" />
</p>

<p align="center"><sub>日常模式 · 用一个稳定结论说明当前是否需要处理</sub></p>

持续问题会保持稳定身份，短暂波动不会被当成故障。指标恢复后，CoreRobin 还会继续确认并补充恢复记录，让你知道问题是否真的结束。

## 本地优先，操作可控

- 监控、历史和偏好保存在当前设备，不上传或同步
- 默认不把应用名称或连接地址写入历史；连接历史需单独启用，并只保存本机五分钟应用/主机聚合
- 用户确认执行的退出、重启、清理和启动项操作会记录结果；清理记录只保留数量和释放空间
- 不会自动结束进程、卸载应用或删除文件
- 系统关键进程、CoreRobin 自身和受保护目录默认不可操作
- 桌面提醒只针对持续问题，并设有重复抑制与每日数量上限

## 下载

前往 [GitHub Releases](https://github.com/JimmyDaddy/corerobin-monitor/releases/latest) 获取适合当前系统的版本：

| 平台 | 安装包 |
| --- | --- |
| macOS | Apple Silicon 与 Intel `.dmg` |
| Windows | `.exe` 与 `.msi` |
| Linux | `.AppImage` 与 `.deb` |

当前发布版本尚未配置平台商业签名或 Apple 公证。Release 同时提供 SHA-256 校验表、SPDX SBOM，以及校验表的 Sigstore 签名包；这些来源完整性记录不能替代平台签名。

## 10 种界面语言

简体中文、繁體中文、English、日本語、Deutsch、Français、Español、Português (Brasil)、한국어、Русский。

## 了解更多

- [中文使用指南](docs/user-guide.zh-CN.md)
- [English user guide](docs/user-guide.md)
- [产品网站](https://monitor-app.corerobin.com/)
- [问题反馈](https://github.com/JimmyDaddy/corerobin-monitor/issues)
- [安全报告](SECURITY.md)
