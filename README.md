# scripting

我的 Scripting（iOS）脚本仓库。每个子目录是一个独立脚本，可以直接当「远程来源」订阅，实现自动更新。

## 脚本列表

| 目录 | 名称 | 说明 |
| --- | --- | --- |
| `ip-check/` | IP检测 1.0.1 | 桌面小组件：出口 IP、地区、ISP、风险评分、VPN/代理状态 |

## 用法

### 1. 直接导入脚本

在 Safari 打开：

```
scripting://import_scripts?urls=%5B%22https%3A%2F%2Fraw.githubusercontent.com%2Fyiyu12138%2Fscripting%2Fmain%2Fdist%2Fip-check.zip%22%5D
```

或者下载 `dist/ip-check.zip` 后用 Scripting 打开。

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

- `ip-check` 修改自 [riccilnl/my-scripting-widgets](https://github.com/riccilnl/my-scripting-widgets) 的「IP检测」。
