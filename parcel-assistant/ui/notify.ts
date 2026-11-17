// 轻提示的全局状态（不依赖 UI，后台逻辑也能调；界面由 ui/toast.tsx 渲染）
export type ToastLevel = "info" | "warn" | "error"

export interface ToastItem {
  id: number
  text: string
  level: ToastLevel
}

type Listener = (t: ToastItem | null) => void

let listeners: Listener[] = []
let timer: any = null
let seq = 0

/** 弹一条提示；3 秒后自动消失，新提示会顶掉旧的 */
export function notify(text: string, level: ToastLevel = "info") {
  const clean = (text || "").trim()
  if (!clean) return
  const item: ToastItem = { id: ++seq, text: clean, level }
  listeners.forEach(l => l(item))
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    listeners.forEach(l => l(null))
    timer = null
  }, 3000)
}

export function onToast(l: Listener): () => void {
  listeners.push(l)
  return () => { listeners = listeners.filter(x => x !== l) }
}
