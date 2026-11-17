/** 主脚本 sync 时把快递 logo 同步进 App Group（widget 扩展只读得到共享目录） */
import { Script } from "scripting"

const LOGO_FILES = ["zto.png", "sf_white.png", "yto.png", "yunda.png", "sto.png", "jtexpress.png",
  "china_post.png", "jd.png", "debang.png", "hive.png", "cainiao.png", "best.png",
  "dhl.png", "fedex.png", "ups.png", "dada.png", "shansong.png"]

/** 每次主脚本启动/写快照时调用；幂等，文件齐全就跳过。
 *  只同步 64px 那套：512px 的 vcards 副本（cc/logos）是历史遗留，
 *  组件在 logos64 齐全时永远读不到它，白占 500KB，已交给「清除缓存」清掉。 */
export function syncLogosToShared(): void {
  try {
    copyDir("logos64", "logos64")
  } catch { }
}

/** 把 assets/<src>/ 下的图标逐个拷到 App Group cc/<dst>/（已存在则跳过） */
function copyDir(src: string, dst: string): void {
  const dstDir = `${FileManager.appGroupDocumentsDirectory}/cc/${dst}`
  if (!FileManager.existsSync(dstDir)) FileManager.createDirectorySync(dstDir, true)
  for (const f of LOGO_FILES) {
    const to = `${dstDir}/${f}`
    if (FileManager.existsSync(to)) continue
    const from = `${Script.directory}/assets/${src}/${f}`
    try {
      if (FileManager.existsSync(from)) FileManager.copyFileSync(from, to)
    } catch { }
  }
}
