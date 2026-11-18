# scripting

我的 Scripting（iOS）脚本仓库。每个子目录是一个独立脚本，可以直接当「远程来源」订阅，实现自动更新。

## 脚本列表

| 目录 | 名称 | 说明 |
| --- | --- | --- |
| `ip-check/` | IP检测 1.0.2 | 桌面小组件：出口 IP、地区、ISP、风险评分、VPN/代理状态 |
| `parcel-assistant/` | 包裹助手 1.2.0 | 快递到站自动提醒取件码，支持驿站匹配、位置提醒与取件统计 |
| `weather-widget/` | 天气小组件 1.4.0 | 主屏幕/锁屏天气组件（镜像自 ios151/Scripting，远程来源已改指本仓库） |
| `report-ip/` | Report ip 1.3.0 | IP / 风险 / 网络诊断小组件（镜像自 worldhellotravel1999-hue/Scripting，新增小组件自动轮询） |

## 用法

### 1. 直接导入脚本

每个版本都发一个 Release，点下面的链接让 Scripting 直接下载：

```
https://github.com/yiyu12138/scripting/releases/download/v1.0.2/ip-check.zip
```

导入链接格式（Safari 打开）：

```
scripting://import_scripts?urls=<encodeURIComponent(JSON数组)>
```

用 Release 资源而不是 raw 链接，是因为 raw.githubusercontent.com 有 5 分钟 CDN 缓存，刚发版时容易拉到旧文件。

### 2. 远程来源 + 自动更新

Scripting → 脚本设置 → 远程来源，填：

```
https://github.com/yiyu12138/scripting/tree/main/ip-check
```

`autoUpdateInterval` 最小 1800 秒（真实生效不低于 30 分钟），建议 `86400`（每天查一次）。App 的全局「自动更新」开关打开后，发现新版本会自动替换。

### 3. 拉取整个仓库

直接填 `https://github.com/yiyu12138/scripting` 也行，App 会列出仓库里的脚本目录供选择。

## 目录规范

- 每个脚本一个目录，目录里必须有 `script.json`，`main` 指向入口文件（小组件是 `widget.tsx`）。
- 目录名用 ASCII（`ip-check`），脚本显示名写在 `script.json` 的 `name` 里（可中文）。
- `dist/*.zip` 是打包好的导入包，zip 里只能有一层外层目录（`ip-check/`）。
- 改版本号时同步改 `script.json` 的 `version`。

## 更新一个脚本

```bash
# 改完源码、递增 version 后重新打包
cd repo && zip -r -q dist/ip-check.zip ip-check
# 提交（网页或 git push 都行）
```

## 来源

- `report-ip` 镜像自 [worldhellotravel1999-hue/Scripting](https://github.com/worldhellotravel1999-hue/Scripting) 的「检测」，加了小组件自动轮询。
- `weather-widget` 镜像自 [ios151/Scripting](https://github.com/ios151/Scripting) 的 WeatherWidget，避免上游删库后不可用。
- `parcel-assistant` 用户自备脚本，原样入库。
- `ip-check` 修改自 [riccilnl/my-scripting-widgets](https://github.com/riccilnl/my-scripting-widgets) 的「IP检测」。
