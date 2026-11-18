# Surge 模块备份

重装 Surge 以后不用再一个个找模块地址。这个脚本通过 Surge 的 HTTP API 把已装模块的原文抓下来，存到本机，也可以推到 GitHub 生成安装链接。

## 前置：打开 Surge 的 HTTP API

在 Surge 当前配置文件的 `[General]` 里加一行：

```
http-api = 你的密钥@0.0.0.0:6171
```

- 脚本跑在同一台 iPhone 上，Surge 主机填 `127.0.0.1`。
- Surge 在 Mac 上，主机填 Mac 的内网 IP，注意打开监听（`0.0.0.0`）。
- iOS 15+ 首次访问会弹「本地网络」权限，允许即可。

## 用法

1. **备份**：点「从 Surge 备份模块」。脚本读 `GET /v1/modules` 列表，再逐个 `GET /v1/modules/detail` 拿原文，存到 App 的 `Documents/SurgeModules/<时间>/`，同目录写一份 `manifest.json`（名称、启用状态、`#!` 头信息）。
2. **上传（可选）**：填 `owner/name` 仓库、分支、GitHub Token（fine-grained，Contents 读写），点「上传最新备份」。文件会写到仓库的 `surge-backup/` 目录。
3. **装回来**：列表里每个模块点「安装」，脚本会打开 `surge:///install-module?url=<raw 地址>`，Surge 自己下载安装。装完点「按备份恢复启用状态」，脚本用 `POST /v1/modules` 批量还原开关。

## 限制

- 内置模块（`type: internal`）跳过，它们本来就在 Surge 里。
- 只备份模块文件本身。模块里 `script-path` 引用的本地脚本、MITM 证书都不在备份范围，重装后要单独处理（证书需要重新安装并信任）。
- 仓库必须是公开的，Surge 才能直接拉 raw；私有库要带 token，本脚本不支持。
- Surge 一次只能装一个模块，所以恢复还是要点 N 次，但不用再翻收藏夹找地址了。
- raw.githubusercontent.com 有 5 分钟缓存，刚上传就点安装可能拿到旧内容，等一下再试。
