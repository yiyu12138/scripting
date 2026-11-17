# 小组件架构与约束（2026-11-15 更新）

## 运行顺序（不可调换）

1. 读共享快照 `cc/widget.json`，叠加 `cc/ops/picked` 事件
2. `Widget.present(...)` —— 首帧只画缓存数据，**前面不允许任何 await**
3. 写 `cc/widgetPresent.log`（真机排查用）
4. `await backgroundSync()` —— 只做联网，最多 3 秒
5. `Script.exit()`

证据：`cc/perf.log` 里 `presented` 时间必须早于 `bg …ms`。把联网挪到 present 之前会灰屏。

## 数据归属

- 快照：App `store.writeWidgetSnapshot()` 写，组件只读；**不写 Keychain 凭据**
- 已取：组件 AppIntent 写 `cc/ops/picked/<id>.json`（单操作单文件），App 落库后删除
- 新包裹：`cc/ops/new/*.json`；物流：`cc/ops/track/*.json`；同样逐条确认
- 调度状态：`cc/widgetTasks.json`；锁 `cc/widgetTasks.lock` 带 token，迟到任务不能删别人的锁

## 硬约束

- 卡片只有一份实现：`ui/parcelCard.tsx`。组件复用，但该文件不能 import `store`（会把 Storage/网络拖进扩展）
- `theme.ts` 的 `UIGlass` 必须是 getter：扩展里没有 `UIGlass`
- 图标：共享目录优先，工程资源兜底；取不到返回 `null`，不画占位白框
- 组件不读 App 私有 Storage；设置一律从快照 `settings` 读
- 后台联网开关 `bgRefresh=false` 时只出图，不联网（灵动岛到期检查仍执行）

## 已知限制

- 单次唤醒联网预算 3 秒；WebView 类平台（京东/拼多多发现、淘宝发现）可能跑不完，下次唤醒续跑；App 内同步不受影响
- 组件**会**做全量发现：`runWidgetTasks` 每次唤醒按“最旧优先”最多补两个平台，总预算 3 秒
- 系统可能合并/延迟 timeline 重建；`reloadPolicy` 只是建议
- 组件只能在 WidgetKit 唤起的执行窗口内工作，不支持常驻后台

## 版本

当前 `WIDGET_VERSION = 1.2.0-w1`，只用于日志与首帧判定，**页脚不再显示版本号**。改组件代码必须同时改版本号。
