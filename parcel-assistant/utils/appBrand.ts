/**
 * 快捷指令识别时「当前是哪个 App」→ 显示成来源 App。
 *
 * 来源不是猜的：快捷指令用 `CurrentApp` 魔法变量取 Bundle Identifier 和名字，
 * 通过 RunScriptIntent 的 texts / urls 两个参数传进来（模板：assets/shortcuts/包裹助手·智能识别.shortcut）。
 *
 * 图标只能用我们自己的资源：iOS 不提供「按 bundle id 读别的 App 图标」的 API。
 * 所以这里维护一张 bundle id → 名字/图标 的表；图标都复用 assets 里已有的图，
 * 认不出的只显示名字（界面用名字首字兜底）。
 */

export interface SourceApp {
  /** Bundle Identifier，如 com.taobao.taobao4iphone */
  id?: string
  /** 快捷指令传来的 App 显示名，如「淘宝」 */
  name?: string
}

interface Entry { name: string; icon?: string }

/** bundle id（小写）→ 名字 + 图标。写错不如不写：认不出就只显示名字，不会崩。 */
const BUNDLES: Record<string, Entry> = {
  // ---- 购物 ----
  "com.taobao.taobao4iphone": { name: "淘宝", icon: "identity/taobao.png" },
  "com.taobao.tmall": { name: "天猫", icon: "identity/tianmao.png" },
  "com.taobao.idlefish": { name: "闲鱼", icon: "identity/xianyu.png" },
  "com.jd.jdmobile": { name: "京东", icon: "identity/jd.png" },
  "com.jingdong.app.mall": { name: "京东", icon: "identity/jd.png" },
  "com.xunmeng.pinduoduo": { name: "拼多多", icon: "identity/pdd.jpg" },
  "com.vip.qing": { name: "唯品会", icon: "identity/vip.png" },
  "com.vip.vipapp": { name: "唯品会", icon: "identity/vip.png" },
  "com.suning.mobile.ebuy": { name: "苏宁易购", icon: "identity/suning.png" },
  "com.wuba.zhuanzhuan": { name: "转转", icon: "identity/zhuanzhuan.png" },
  // ---- 快递 / 驿站 ----
  "com.cainiao.wireless": { name: "菜鸟", icon: "identity/cainiao.png" },
  "com.taobao.cainiao": { name: "菜鸟", icon: "identity/cainiao.png" },
  "com.fcbox.hivebox": { name: "丰巢", icon: "logos64/hive.png" },
  "com.xiaomi.smarthome": { name: "小米快递", icon: "identity/mi.png" },
  "com.sf-express.express": { name: "顺丰速运", icon: "logos64/sf_white.png" },
  "com.zto.express": { name: "中通快递", icon: "logos64/zto.png" },
  "com.sto.express": { name: "申通快递", icon: "logos64/sto.png" },
  "com.yto.mobile": { name: "圆通速递", icon: "logos64/yto.png" },
  "com.yunda.express": { name: "韵达快递", icon: "logos64/yunda.png" },
  "com.jtexpress.app": { name: "极兔速递", icon: "logos64/jtexpress.png" },
  "com.deppon.app": { name: "德邦快递", icon: "logos64/debang.png" },
  "com.chinapost.ems": { name: "中国邮政", icon: "logos64/china_post.png" },
  // ---- 还没图标、只认名字的 ----
  "com.ss.iphone.ugc.aweme": { name: "抖音", icon: "identity/douyin.png" },
  "com.shizhuang.duapp": { name: "得物", icon: "identity/dewu.png" },
  "com.xingin.discover": { name: "小红书", icon: "identity/xiaohongshu.png" },
  "com.xingin.xhs": { name: "小红书", icon: "identity/xiaohongshu.png" },
  "com.kuaishou.nebula": { name: "快手极速版", icon: "identity/kuaishou.png" },
  "com.jiangjia.gif": { name: "快手", icon: "identity/kuaishou.png" },
  "com.tencent.xin": { name: "微信", icon: "identity/weixin.png" },
  "com.alipay.iphoneclient": { name: "支付宝", icon: "identity/alipay.png" },
  "com.apple.mobilesafari": { name: "Safari" },
  "com.apple.mobileslideshow": { name: "照片" },
}

export interface Brand {
  /** 显示名，保证非空 */
  name: string
  /** 图标相对 assets 的路径；没有就不返回，界面走首字母兜底 */
  icon?: string
}

export function brandOf(app?: SourceApp | string | null): Brand | null {
  if (!app) return null
  const id = (typeof app === "string" ? app : app.id || "").trim()
  const given = (typeof app === "string" ? "" : app.name || "").trim()
  if (!id && !given) return null
  const hit = BUNDLES[id.toLowerCase()]
  if (hit) return { name: hit.name, ...(hit.icon ? { icon: hit.icon } : {}) }
  const name = given || (id ? id.split(".").pop() || id : "")
  return name ? { name } : null
}
