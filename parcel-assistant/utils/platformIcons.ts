// 平台小标（淘宝/京东/拼多多）与来源 App 图标（抖音/得物/小红书…）复制一份到 App Group：
// 桌面小组件在扩展进程里读不到主工程的 iCloud 资源目录，跟快递 logo 用同一套办法。
import { Script } from "scripting"

/** 平台单的小标（按 source 取） */
const SRC: Record<string, string> = {
  taobao: "identity/taobao.png",
  jd: "identity/jd.png",
  pdd: "identity/pdd.jpg",
  fengchao: "logos64/hive.png",
}

/** 来源 App 图标（按 bundle id 归一出的 key 取）——与 utils/appBrand.ts 的表保持同步 */
const BRAND_SRC: Record<string, string> = {
  taobao: "identity/taobao.png",
  tmall: "identity/tianmao.png",
  xianyu: "identity/xianyu.png",
  jd: "identity/jd.png",
  pdd: "identity/pdd.jpg",
  vip: "identity/vip.png",
  suning: "identity/suning.png",
  zhuanzhuan: "identity/zhuanzhuan.png",
  cainiao: "identity/cainiao.png",
  mi: "identity/mi.png",
  douyin: "identity/douyin.png",
  dewu: "identity/dewu.png",
  xiaohongshu: "identity/xiaohongshu.png",
  kuaishou: "identity/kuaishou.png",
  weixin: "identity/weixin.png",
  alipay: "identity/alipay.png",
}

/** bundle id（小写）→ 图标 key。只收有图标的；认不出就不显示图标。 */
const BUNDLE_KEY: Record<string, string> = {
  "com.taobao.taobao4iphone": "taobao",
  "com.taobao.tmall": "tmall",
  "com.taobao.idlefish": "xianyu",
  "com.jd.jdmobile": "jd",
  "com.jingdong.app.mall": "jd",
  "com.xunmeng.pinduoduo": "pdd",
  "com.vip.qing": "vip",
  "com.vip.vipapp": "vip",
  "com.suning.mobile.ebuy": "suning",
  "com.wuba.zhuanzhuan": "zhuanzhuan",
  "com.cainiao.wireless": "cainiao",
  "com.taobao.cainiao": "cainiao",
  "com.xiaomi.smarthome": "mi",
  "com.ss.iphone.ugc.aweme": "douyin",
  "com.shizhuang.duapp": "dewu",
  "com.xingin.discover": "xiaohongshu",
  "com.xingin.xhs": "xiaohongshu",
  "com.kuaishou.nebula": "kuaishou",
  "com.jiangjia.gif": "kuaishou",
  "com.tencent.xin": "weixin",
  "com.alipay.iphoneclient": "alipay",
}

/** App 显示名 → 图标 key（快捷指令有时只给名字、不给 bundle id） */
const NAME_KEY: Record<string, string> = {
  "淘宝": "taobao",
  "天猫": "tmall",
  "闲鱼": "xianyu",
  "京东": "jd",
  "拼多多": "pdd",
  "唯品会": "vip",
  "苏宁易购": "suning",
  "转转": "zhuanzhuan",
  "菜鸟": "cainiao",
  "小米快递": "mi",
  "抖音": "douyin",
  "得物": "dewu",
  "小红书": "xiaohongshu",
  "快手": "kuaishou",
  "快手极速版": "kuaishou",
  "微信": "weixin",
  "支付宝": "alipay",
}

const DIR = () => `${FileManager.appGroupDocumentsDirectory}/cc/platform`

/** App 启动时跑一次；已存在就跳过（新增的 key 下次启动会自动补） */
export function syncPlatformIcons(): void {
  try {
    const dir = DIR()
    if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
    const all: Record<string, string> = { ...SRC, ...BRAND_SRC }
    for (const key of Object.keys(all)) {
      const dst = `${dir}/${key}.png`
      if (FileManager.existsSync(dst)) continue
      const src = `${Script.directory}/assets/${all[key]}`
      if (!FileManager.existsSync(src)) continue
      const img = UIImage.fromFile(src)
      if (!img) continue
      const small = img.preparingThumbnail({ width: 44, height: 44 }) ?? img
      const data = small.toPNGData()
      if (data) FileManager.writeAsDataSync(dst, data)
    }
  } catch { }
}

/** 共享目录里的平台小标路径；没有就返回空串（调用方不显示） */
export function platformIconPath(source?: string): string {
  const key = source && SRC[source] ? source : ""
  if (!key) return ""
  const path = `${DIR()}/${key}.png`
  try { return FileManager.existsSync(path) ? path : "" } catch { return "" }
}

/** 来源 App（bundle id 或名字）→ 共享目录里的图标路径；认不出返回空串 */
export function appBrandIconPath(app?: { id?: string; name?: string }): string {
  const id = String(app?.id ?? "").trim().toLowerCase()
  const nm = String(app?.name ?? "").trim()
  const key = (id && BUNDLE_KEY[id]) || (nm && NAME_KEY[nm]) || ""
  if (!key) return ""
  const path = `${DIR()}/${key}.png`
  try { return FileManager.existsSync(path) ? path : "" } catch { return "" }
}
