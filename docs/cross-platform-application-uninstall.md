# 跨平台应用卸载设计

CoreRobin 的 macOS 卸载助手以经过验证的 `.app` bundle 和 Bundle ID 为边界，删除应用本体及明确归属的用户目录数据。Windows 与 Linux 的安装、升级和卸载归属于系统安装器或包管理器，不能复用 macOS 的路径删除模型。

## 当前产品边界

| 平台 | 当前能力 | 对用户的表达 |
| --- | --- | --- |
| macOS | 扫描 `/Applications` 与用户 Applications，生成应用本体和 Bundle ID 归属数据的复核计划 | 支持完整复核、移到废纸篓或直接删除 |
| Windows | 从系统 MSI 与 MSIX/AppX 清单缓存生成短期卸载计划，执行前只定向核对所选标识并调用系统安装器 | 展示安装来源、系统卸载方式和提权边界；无法验证的 Win32 安装器保持只读 |
| Linux | 从 XDG desktop entry 与 Flatpak、Snap、dpkg 或 RPM 归属缓存生成短期计划，执行前只查询所选包并调用对应包管理器 | 展示包来源与提权边界；AppImage、手工解压程序和无法识别来源的条目保持只读 |

这些代码路径已经交付，但 Windows/Linux 仍属于早期预览，真实设备验收状态必须继续在发布说明中如实表达。发布 smoke 需要验证清单、本地化名称、计划、取消、提权失败和完成后的重新枚举；不得把读取失败或空清单表述成“没有安装应用”。

## Windows 方案

后端只从系统维护的安装来源构建清单，前端不得提交可执行命令。

1. 合并当前用户与本机的 32/64 位 Uninstall 注册表视图，读取显示名称、发布者、安装位置、图标、版本、EstimatedSize 和安装器标记。
2. MSI 条目必须使用经过规范化并重新核对的 ProductCode，由后端以参数数组启动 `msiexec.exe /x {ProductCode}`。
3. MSIX/AppX 条目使用 Package Family Name 作为稳定身份，通过 Windows Package Manager API 或受约束的系统命令请求卸载。
4. NSIS/Inno Setup 等 Win32 条目只接受注册表中指向现存绝对 `.exe` 的卸载器；不经过 shell，不解析管道、重定向、环境展开或任意附加命令。
5. 完整清单按安装源指纹和短期 TTL 缓存；执行前只重新读取所选 ProductCode 或 Package Family Name，验证来源与标识没有变化。需要提升权限时交给 Windows UAC；CoreRobin 不保存管理员凭据。
6. 卸载完成后定向确认所选包是否仍存在并显示退出码，再使清单缓存失效。残留数据只能在应用卸载完成后按已验证发布者/应用身份另行复核，不能猜测目录名后直接删除。

当前已支持 MSI 与 MSIX/AppX。常见 NSIS/Inno Setup 仍保持只读，直到可以验证注册表卸载器文件身份且不解析任意命令行；无法证明安装器类型或身份的条目同样保持只读。

## Linux 方案

Linux 清单以 `.desktop` 文件为展示入口，以包数据库的文件归属为卸载身份，不能直接删除 `/usr` 下的文件。

1. 扫描系统与用户 XDG application roots，并解析 `Name`、本地化名称、`Exec`、`Icon`、`NoDisplay`。
2. 用 desktop 文件或可执行文件反查归属，按顺序识别 Flatpak、Snap、dpkg/apt 与 RPM 系包管理器；RPM 归属按批次查询，避免为每个 desktop entry 启动一次进程。
3. Flatpak 区分 user/system installation；Snap、dpkg 和 RPM 使用包管理器的规范包 ID。
4. 后端根据识别出的枚举策略生成固定二进制和参数数组，不经过 shell。系统级卸载通过发行版提供的 PolicyKit/软件中心授权，不在 CoreRobin 中收集密码。
5. 清单按 XDG 根目录和包数据库指纹缓存；执行前只查询所选规范包 ID，完成后定向确认包状态、报告退出码并使清单缓存失效。
6. AppImage、手工解压程序和无法识别来源的 desktop entry 首期只提供“在文件管理器中显示”，不声称能彻底卸载。

当前代码支持 Flatpak、deb、RPM 与 Snap 的规范包 ID 和固定参数数组。对应平台仍须完成实机矩阵，产品界面和发布说明不得把自动化编译等同于全面兼容。

## 安全与交互契约

- 前端只传递后端生成的短期计划 ID；不传命令行、卸载器路径或包管理器参数。
- 计划绑定平台安装源、稳定包 ID、清单路径和采样时间，使用随机 128 位 ID 并在 10 分钟后过期；执行时计划只能使用一次，且会定向查询所选包核对身份。切换展示选项不会重复扫描。
- 所有外部系统命令都有超时和输出上限；某个安装源读取失败时保留其他来源的结果并明确报告，不会让整个清单永久等待。
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

实现状态与实机验收状态必须分开记录。GitHub runner 的跨平台编译、包结构检查和单元测试证明代码边界，但不能替代真实设备上的 UAC/PolicyKit、取消、包管理器锁冲突和卸载完成验证。
