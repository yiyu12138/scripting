/**
 * 极简 RSA 公钥加密（RSAES-PKCS1-v1_5），纯 BigInt 实现。
 *
 * 为什么不用 node:crypto：Scripting 的 crypto shim 暴露了 createPublicKey/publicEncrypt，
 * 但底层直接抛 "Asymmetric keys (RSA/EC) are not supported on this platform"（2026-11-14 实测）。
 * WebCrypto 同样不支持 PKCS1v15 加密（只允许 RSA-OAEP）。丰巢签名要的正是 PKCS1v15，
 * 所以这里自己解析 SPKI、按 RFC 8017 做填充和模幂运算。
 */

export interface RsaPub {
  n: bigint
  e: bigint
  /** 模长字节数（k） */
  bytes: number
}

interface Tlv { tag: number; start: number; len: number; next: number }

function readTlv(buf: Uint8Array, pos: number): Tlv {
  const tag = buf[pos]
  let p = pos + 1
  let len = buf[p++]
  if (len & 0x80) {
    const n = len & 0x7f
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++]
  }
  return { tag, start: p, len, next: p + len }
}

function readInteger(buf: Uint8Array, t: Tlv): bigint {
  let i = t.start
  const end = t.start + t.len
  while (i < end - 1 && buf[i] === 0) i++
  let v = 0n
  for (; i < end; i++) v = (v << 8n) | BigInt(buf[i])
  return v
}

/** 解析 DER 编码的 SubjectPublicKeyInfo（openssl -pubout -outform DER 的产物） */
export function parseSpki(der: Uint8Array): RsaPub {
  const top = readTlv(der, 0)
  let p = top.start
  const alg = readTlv(der, p)
  p = alg.next
  const bit = readTlv(der, p)
  // BIT STRING 内容首字节是 unused bits（0），跳过它才是 RSAPublicKey 的 SEQUENCE
  const inner = readTlv(der, bit.start + 1)
  let q = inner.start
  const nTlv = readTlv(der, q)
  q = nTlv.next
  const eTlv = readTlv(der, q)
  const n = readInteger(der, nTlv)
  const e = readInteger(der, eTlv)
  const bytes = Math.ceil(n.toString(16).length / 2)
  return { n, e, bytes }
}

/** 解析 base64 编码的公钥（丰巢把 SPKI 拆成 key1..key5，按 keyOrder 拼回 base64） */
export function parseSpkiBase64(b64: string): RsaPub {
  const raw = b64.replace(/[^A-Za-z0-9+/=]/g, "")
  const bin = atobLike(raw)
  return parseSpki(bin)
}

function atobLike(b64: string): Uint8Array {
  // 环境里可能没有 atob（非浏览器），用 Buffer 兜底
  try {
    const buf = (globalThis as any).Buffer
    if (buf) return new Uint8Array(buf.from(b64, "base64"))
  } catch { }
  const bin = (globalThis as any).atob ? (globalThis as any).atob(b64) : ""
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n
  let x = base % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) r = (r * x) % mod
    x = (x * x) % mod
    e >>= 1n
  }
  return r
}

function randomNonZero(): number {
  for (;;) {
    let b = 0
    try {
      const crypto = (globalThis as any).crypto
      const arr = new Uint8Array(1)
      crypto.getRandomValues(arr)
      b = arr[0]
    } catch {
      b = Math.floor(Math.random() * 256)
    }
    if (b !== 0) return b
  }
}

/** RSAES-PKCS1-v1_5 加密，返回密文字节 */
export function rsaEncryptPkcs1(msg: Uint8Array, pub: RsaPub): Uint8Array {
  const k = pub.bytes
  if (msg.length > k - 11) throw new Error("RSA: 明文过长")
  const psLen = k - 3 - msg.length
  const em = new Uint8Array(k)
  em[0] = 0x00
  em[1] = 0x02
  for (let i = 0; i < psLen; i++) em[2 + i] = randomNonZero()
  em[2 + psLen] = 0x00
  em.set(msg, 3 + psLen)

  let m = 0n
  for (let i = 0; i < k; i++) m = (m << 8n) | BigInt(em[i])
  const c = modPow(m, pub.e, pub.n)

  const out = new Uint8Array(k)
  let v = c
  for (let i = k - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function toBase64(bytes: Uint8Array): string {
  const buf = (globalThis as any).Buffer
  if (buf) return buf.from(bytes).toString("base64")
  let s = ""
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return (globalThis as any).btoa(s)
}

function utf8(s: string): Uint8Array {
  const buf = (globalThis as any).Buffer
  if (buf) return new Uint8Array(buf.from(s, "utf8"))
  const out: number[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  return new Uint8Array(out)
}

/** 便捷入口：用 base64 公钥加密一段文字，返回 base64 密文 */
export function encryptWithBase64Key(text: string, pubB64: string): string {
  const pub = parseSpkiBase64(pubB64)
  return toBase64(rsaEncryptPkcs1(utf8(text), pub))
}
