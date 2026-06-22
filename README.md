# 自动更新检测程序

监控源目录(实际使用中通常是挂载的 SMB 共享盘)变更,镜像同步到目标目录,带 N 版备份、一键回退、文件映射规则、开机自启、更新弹框。

## 下载

去 [Releases 页](https://github.com/zeroko12/auto-updater/releases) 选最新 `v*` tag 的资产:

| 平台 | 架构 | 文件 | 启动 |
|------|------|------|------|
| Windows | x64 | `自动更新检测-<version>-x64.exe` | 双击运行 NSIS 安装包 |
| macOS | Apple Silicon (M1/M2/M3) | `自动更新检测-<version>-arm64.dmg` | 双击 dmg 拖入 Applications,首次启动需 **右键 → 打开** |
| macOS | Intel | `自动更新检测-<version>.dmg` | 同上 |
| Linux | x64 | `自动更新检测-<version>.AppImage` | `chmod +x *.AppImage && ./自动更新检测-<version>.AppImage` |
| Linux | ARM64 (树莓派 / Graviton) | `自动更新检测-<version>-arm64.AppImage` | 同上 |

> macOS 客户端 **未做代码签名**,首次启动会看到 Gatekeeper 警告。
> 已经打开过一次后还想消除警告,运行:
> ```bash
> xattr -d com.apple.quarantine "/Applications/自动更新检测.app"
> ```

### 自动发布

打 `v*` tag 推到 origin 后,GitHub Actions 会自动跑 5 个平台打包并合并到该 tag 的 Release。手动 dry-run(只下载不发布 Release)可以走 Actions → CI → Run workflow。

## 技术栈

- **运行时**:Electron 33+ / Node 22
- **UI**:Vue 3 + TypeScript + Vite
- **核心**:纯 TypeScript(`src/core/`),平台无关
- **测试**:Vitest

## 目录结构

```
src/
├── core/                    # 平台无关核心逻辑
│   ├── types.ts             # 类型定义
│   ├── config.ts            # ConfigManager
│   ├── indexer.ts           # 目录扫描(mtime+size)
│   ├── syncer.ts            # 同步引擎(镜像 + 文件映射)
│   ├── scheduler.ts         # 间隔轮询
│   └── cli.ts               # CLI 入口
├── main/                    # Electron 主进程
│   └── index.ts
├── preload/                 # Preload 桥接
│   └── index.ts
└── renderer/                # Vue 3 UI
    ├── index.html
    └── src/
        ├── App.vue
        ├── main.ts
        └── env.d.ts
tests/                       # Vitest 测试
```

## 快速开始

```bash
# 装依赖
npm install

# 跑测试
npm test

# 初始化默认配置(写到 %APPDATA%/auto-updater/config.json)
npm run init-config

# 编辑配置,设置 sourceDir / targetDir
# 然后手动跑一次
npm run sync-once

# 持续按间隔同步
npm run watch
```

## Electron 开发模式

```bash
npm run dev   # 启动 Electron + Vue HMR
```

## 配置位置

- **Windows**: `%APPDATA%/auto-updater/config.json`
- **macOS**: `~/Library/Application Support/auto-updater/config.json`
- **Linux**: `~/.config/auto-updater/config.json`

## 镜像模式说明

目标目录 = 源目录的精确副本。
- 源新增 → 目标新增
- 源修改 → 目标覆盖
- 源删除 → 目标删除
- 目标里有但源里没有的"孤儿" → 也会被删除

## 备份目录

`config.json` 里的 `backupDir` 字段控制备份位置:
- **空字符串**(默认)= 派生自 `targetDir`,在父目录的兄弟位置生成 `<targetDir>-backups`
- **非空** = 覆盖默认值,可以使用任意绝对路径(跨盘符、跨设备都 OK)
- **不允许等于 `targetDir`**(配置校验会拒绝),否则镜像同步会误删备份

举例:
- `targetDir = "D:/game/data"` → 备份 = `"D:/game/data-backups"`
- `targetDir = "Z:/updates/app"` → 备份 = `"Z:/updates/app-backups"`

CLI 覆盖:
```bash
npm run sync-once -- --target D:/game/data --backup-dir E:/cold-storage/game-snapshots
```

## 文件映射规则

通过 UI 配置的额外拷贝规则,源在目标根之外(本地文件)。镜像同步时**这些目标路径自动从删除列表中豁免**,然后追加执行"缺失补回"逻辑。

### 字段说明

| 字段 | 含义 |
|------|------|
| `name` | 显示名(日志和 UI 标识用) |
| `sourcePath` | 本地文件绝对路径(模板/默认配置的位置) |
| `targetRelpath` | 相对 targetDir 的路径(如 `config/app.ini`) |
| `overwrite` | `false`(默认)= 仅目标缺失时补回;`true` = 每次强制覆盖 |
| `ifSourceMissing` | 源文件不存在时的策略:`skip` / `keep` / `delete` |
| `enabled` | 是否启用此规则 |

### 核心语义

- **镜像删除阶段:这些路径被豁免** — 即使源里没有,也不会被镜像清掉(结果不会报 `deleted`)
- **`overwrite=false`(默认,推荐)**:目标已存在 → 跳过,记入 `mappingSkippedExisting`;目标缺失 → 从 source 补回
- **`overwrite=true`**:每次同步都强制从 source 覆盖目标(用于配置强制刷新)

### 典型用法

| 场景 | 配置 |
|------|------|
| 用户配置文件模板 | `overwrite=false`,首次部署补一份,用户后续编辑不被打扰 |
| 默认配置 / 启动脚本 | `overwrite=true`,每次更新都强制刷新成最新版本 |
| 用户误删保护 | `overwrite=false`,用户删了下次同步自动从模板补回 |

### 结果统计

- `mappingCopied`:实际写入(overwrite=true 覆盖 / overwrite=false 缺失补)
- `mappingSkippedExisting`:目标已存在且 overwrite=false,跳过
- `mappingSkipped`:源文件不存在,按 `ifSourceMissing` 跳过

## License

MIT
