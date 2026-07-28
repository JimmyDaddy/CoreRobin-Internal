# 跨平台应用卸载设计

CoreRobin 的 macOS 卸载助手以经过验证的 `.app` bundle 和 Bundle ID 为边界，删除应用本体及明确归属的用户目录数据。Windows 与 Linux 的安装、升级和卸载归属于系统安装器或包管理器，不能复用 macOS 的路径删除模型。

## 当前产品边界

| 平台 | 当前能力 | 对用户的表达 |
| --- | --- | --- |
| macOS | 扫描 `/Applications` 与用户 Applications，生成应用本体和 Bundle ID 归属数据的复核计划 | 支持完整复核、移到废纸篓或直接删除 |
| Windows | 尚未交付安装源识别与受信卸载器调度 | 明确显示暂不支持，不生成或执行路径删除计划 |
| Linux | 尚未交付包归属识别与发行版提权流程 | 明确显示暂不支持，不生成或执行路径删除计划 |

发布实机 smoke 必须覆盖这个能力边界。macOS 需要验证清单、计划和取消流程；Windows/Linux 在对应实现交付前需要验证降级文案真实、稳定，不得把空清单表述成“没有安装应用”。

## Windows 方案

后端只从系统维护的安装来源构建清单，前端不得提交可执行命令。

1. 合并当前用户与本机的 32/64 位 Uninstall 注册表视图，读取显示名称、发布者、安装位置、图标、版本、EstimatedSize 和安装器标记。
2. MSI 条目必须使用经过规范化并重新核对的 ProductCode，由后端以参数数组启动 `msiexec.exe /x {ProductCode}`。
3. MSIX/AppX 条目使用 Package Family Name 作为稳定身份，通过 Windows Package Manager API 或受约束的系统命令请求卸载。
4. NSIS/Inno Setup 等 Win32 条目只接受注册表中指向现存绝对 `.exe` 的卸载器；不经过 shell，不解析管道、重定向、环境展开或任意附加命令。
5. 执行前重新读取相同注册表项，验证来源、标识和卸载器文件身份没有变化。需要提升权限时交给 Windows UAC；CoreRobin 不保存管理员凭据。
6. 卸载完成后重新枚举安装源并显示退出码。残留数据只能在应用卸载完成后按已验证发布者/应用身份另行复核，不能猜测目录名后直接删除。

首批支持顺序为 MSI、MSIX，再评估常见 NSIS/Inno Setup。无法证明安装器类型或身份的条目保持只读。

## Linux 方案

Linux 清单以 `.desktop` 文件为展示入口，以包数据库的文件归属为卸载身份，不能直接删除 `/usr` 下的文件。

1. 扫描系统与用户 XDG application roots，并解析 `Name`、本地化名称、`Exec`、`Icon`、`NoDisplay`。
2. 用 desktop 文件或可执行文件反查归属，按顺序识别 Flatpak、Snap、dpkg/apt 与 RPM 系包管理器。
3. Flatpak 区分 user/system installation；Snap、dpkg 和 RPM 使用包管理器的规范包 ID。
4. 后端根据识别出的枚举策略生成固定二进制和参数数组，不经过 shell。系统级卸载通过发行版提供的 PolicyKit/软件中心授权，不在 CoreRobin 中收集密码。
5. 执行前重新查询包数据库，确认 desktop 文件仍归属于同一包；完成后重新枚举包状态并报告结果。
6. AppImage、手工解压程序和无法识别来源的 desktop entry 首期只提供“在文件管理器中显示”，不声称能彻底卸载。

首批支持顺序为 Flatpak 与 deb；RPM/Snap 只有在对应实机矩阵完成后才标记支持。

## 安全与交互契约

- 前端只传递后端生成的短期计划 ID；不传命令行、卸载器路径或包管理器参数。
- 计划绑定平台安装源、稳定包 ID、当前用户和采样时间；执行前强制重新核对身份，但切换展示选项不重复扫描。
- CoreRobin 自身、系统组件、驱动、运行库和被安装源标记为不可移除的条目必须保护。
- 计划页展示安装来源、将调用的系统卸载方式、是否需要提权，以及“关联数据不会自动猜测删除”。
- 失败、取消和需要重启是不同结果；不得因进程已启动就显示卸载成功。
- 图标和本地化名称继续使用通用应用元数据组件，原始来源路径只用于后端验证。

## 实机验收矩阵

| 平台 | 清单与名称/图标 | 计划身份复核 | 取消 | 完成与重新枚举 | 提权/失败路径 |
| --- | --- | --- | --- | --- | --- |
| macOS arm64/x64 | `.app` / Bundle metadata | bundle path + Bundle ID | 必测 | 必测 | 文件不可访问、应用仍运行 |
| Windows x64 MSI | 注册表 / ProductCode | MSI ProductCode | 必测 | 必测 | UAC 取消、安装器退出失败 |
| Windows x64 MSIX | package catalog / PFN | Package Family Name | 必测 | 必测 | 系统应用受保护 |
| Linux x64 Flatpak | XDG / app ID | installation + app ID | 必测 | 必测 | user/system scope |
| Linux x64 deb | XDG / dpkg owner | package name + architecture | 必测 | 必测 | PolicyKit 取消、锁冲突 |

每一行只有在真实设备上使用候选安装包通过后，才能从“设计中”调整为产品支持。GitHub runner 的编译、包结构检查和 dry-run 清单不能替代这些证据。
