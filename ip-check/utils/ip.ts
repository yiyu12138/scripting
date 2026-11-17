// File: utils/ip.ts
// 获取 IP 信息并计算风险值（修正版）
import { fetch, Device } from "scripting"

export const API_URL = "http://ip-api.com/json/?lang=zh-CN"

// 国内探针：只有真正部署在境内的节点才有意义。
// ip.3322.net / ddns.oray.com 现在大量失效（2026-11 实测超时），换用 ipip 优先。
const CHINA_IP_APIS = [
  "https://myip.ipip.net",        // 首选：国内服务器，纯文本
  "https://ip.3322.net",          // 备用1
  "https://ddns.oray.com/checkip" // 备用2
]

export interface IPInfo {
  query: string;
  country: string;
  countryCode: string;
  regionName: string;
  city: string;
  isp: string;
  org: string;
  as: string;
  status: string;
}

const RISK_KEYWORDS = {
  dataCenter: [
    "数据中心", "机房", "IDC",
    "Amazon", "AWS", "Google", "Microsoft", "Azure", "Oracle", "Tencent", "Alibaba",
    "Cloudflare", "DMIT", "Vultr", "DigitalOcean", "Linode", "OVH", "Hetzner", "Contabo",
    "Leaseweb", "RackNerd", "CloudCone", "BandwagonHost", "V.PS", "Misaka", "Akile",
    "ByteVirt", "阿里云", "腾讯云", "华为云", "金山云", "UCloud"
  ],
  homeBroadband: ["电信", "移动", "联通", "广电", "宽带", "Comcast", "Verizon", "ChinaNet", "家庭", "住宅"],
  highRiskCountries: ["俄罗斯", "印度", "乌克兰"],
  vpnKeywords: ["VPN", "Proxy", "Tunnel", "虚拟", "加速器", "节点"]
};

/**
 * 获取本地活跃的网络接口信息
 * 只在真的存在 tun/utun/ppp 这类隧道接口（且拿到非内网 IPv4）时才算 VPN
 */
function getLocalNetworkInfo(): { hasVPNInterface: boolean; ifaceNames: string[] } {
  try {
    const interfaces = Device.networkInterfaces();
    const vpnInterfaceKeywords = ["utun", "ppp", "ipsec", "tun", "tap", "wireguard", "wg"];
    const ifaceNames: string[] = [];

    for (const [name, addresses] of Object.entries(interfaces || {})) {
      const lowerName = name.toLowerCase();
      if (!vpnInterfaceKeywords.some(kw => lowerName.includes(kw))) continue;
      const list = Array.isArray(addresses) ? addresses : [];
      const hasExternal = list.some((addr: any) => !addr.isInternal && addr.family === "IPv4");
      if (hasExternal) ifaceNames.push(name);
    }

    return { hasVPNInterface: ifaceNames.length > 0, ifaceNames };
  } catch (e) {
    return { hasVPNInterface: false, ifaceNames: [] };
  }
}

function isPrivateIP(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // CGNAT
  return false;
}

function analyzeISP(isp: string, org: string): {
  isDataCenter: boolean;
  isHomeBroadband: boolean;
  isVPNService: boolean;
  confidence: number;
} {
  const ispLower = (isp || "").toLowerCase();
  const orgLower = (org || "").toLowerCase();
  const combined = `${ispLower} ${orgLower}`;

  const isDataCenter = RISK_KEYWORDS.dataCenter.some(kw => combined.includes(kw.toLowerCase()));
  const isHomeBroadband = RISK_KEYWORDS.homeBroadband.some(kw => combined.includes(kw.toLowerCase()));
  const isVPNService = RISK_KEYWORDS.vpnKeywords.some(kw => combined.includes(kw.toLowerCase()));

  let confidence = 50;
  if (isDataCenter) confidence += 30;
  if (isVPNService) confidence += 20;
  if (isHomeBroadband) confidence -= 20;

  return { isDataCenter, isHomeBroadband, isVPNService, confidence: Math.max(0, Math.min(100, confidence)) };
}

function isOverseasIP(ipInfo: IPInfo): boolean {
  if (ipInfo.countryCode && ipInfo.countryCode !== "CN") return true;
  if (ipInfo.country && !ipInfo.country.includes("中国")) return true;
  return false;
}

/**
 * 综合判断 VPN/代理状态
 *
 * 关键修正：以前只有在「拿不到国内 IP」时才用海外 IP 兜底，
 * 结果全代理（国内探针也看到海外 IP）时两个 IP 一样，判定成直连。
 * 现在出口在海外本身就是代理的铁证，优先按它判。
 */
export function detectVPNStatus(
  ipInfo: IPInfo,
  chinaIP: string | null
): {
  isVPN: boolean;
  isProxy: boolean;
  proxyType: string;
  confidence: number;
  method: string;
} {
  const localInfo = getLocalNetworkInfo();
  const ispAnalysis = analyzeISP(ipInfo.isp, ipInfo.org);
  const intlIP = ipInfo.query;
  const overseas = isOverseasIP(ipInfo);

  let vpnScore = 0;
  let isProxy = false;
  let proxyType = "";
  const methods: string[] = [];

  // 1. 出口 IP 在海外：国内直连不可能出现，等同代理
  if (overseas) {
    isProxy = true;
    vpnScore += 50;
    methods.push("海外出口");
  }

  // 2. 国内探针和出口 IP 不同 = 分流代理
  if (chinaIP && intlIP && chinaIP !== intlIP) {
    isProxy = true;
    proxyType = "分流代理";
    vpnScore += 20;
    methods.push("IP分流");
  }

  // 3. 隧道接口（系统级 VPN）
  if (localInfo.hasVPNInterface) {
    vpnScore += 40;
    methods.push("VPN接口");
  }

  // 4. ISP 特征
  if (ispAnalysis.isVPNService) {
    vpnScore += 35;
    methods.push("VPN服务商");
  } else if (ispAnalysis.isDataCenter) {
    vpnScore += 25;
    methods.push("数据中心");
  }

  if (ispAnalysis.isHomeBroadband && !ispAnalysis.isDataCenter) {
    vpnScore -= 20;
    methods.push("家宽特征");
  }

  let confidence = ispAnalysis.confidence;
  if (vpnScore > 0) {
    confidence = Math.min(95, confidence + vpnScore);
  } else {
    confidence = Math.max(5, confidence);
  }

  const isVPN = vpnScore >= 60;

  // 没拿到隧道，但出口在海外：按有没有对比出分流来命名
  if (isProxy && !localInfo.hasVPNInterface && !proxyType) {
    proxyType = chinaIP ? "全局代理" : "代理";
  }

  return {
    isVPN,
    isProxy,
    proxyType,
    confidence,
    method: methods.length > 0 ? methods.join("+") : "直连"
  };
}

export async function fetchIPInfo(): Promise<IPInfo | null> {
  try {
    const response = await fetch(API_URL);
    return await response.json();
  } catch (error) {
    console.error("获取 IP 数据失败：", error);
    return null;
  }
}

/**
 * 获取国内出口 IP（用于对比检测分流代理/旁路由）
 * 只用境内探针，境内探针全挂时返回 null，不再拿 ipify 这种全球接口凑数
 */
export async function fetchChinaIP(): Promise<string | null> {
  for (const apiUrl of CHINA_IP_APIS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(apiUrl, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) continue;

      const text = await response.text().catch(() => "");
      let ip: string | null = null;
      try {
        const data = JSON.parse(text);
        ip = data.ip || data.query || data.origin || null;
      } catch {
        const ipMatch = text.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
        if (ipMatch) ip = ipMatch[0];
      }

      if (ip && !isPrivateIP(ip)) {
        console.log(`[IP检测] 国内探针: ${ip} (${apiUrl})`);
        return ip;
      }
    } catch (error) {
      continue;
    }
  }

  console.log("[IP检测] 国内探针不可用，改用出口位置判断");
  return null;
}

export function calculateRiskValue(ipInfo: IPInfo, chinaIP: string | null = null) {
  let riskValue = 0;

  const vpnStatus = detectVPNStatus(ipInfo, chinaIP);
  const ispAnalysis = analyzeISP(ipInfo.isp, ipInfo.org);

  if (vpnStatus.isVPN || vpnStatus.isProxy) {
    riskValue += vpnStatus.confidence * 0.5;
  }
  if (ispAnalysis.isDataCenter) riskValue += 20;
  if (ispAnalysis.isHomeBroadband) riskValue -= 15;
  if (RISK_KEYWORDS.highRiskCountries.some(kw => (ipInfo.country || "").includes(kw))) riskValue += 25;

  riskValue = Math.max(0, Math.min(100, riskValue));

  let vpnStatusText = "未连接";
  let vpnColorKey: "safe" | "warning" | "secondary" = "secondary";
  if (vpnStatus.isVPN || vpnStatus.isProxy) {
    vpnStatusText = vpnStatus.proxyType || "已连接";
    vpnColorKey = vpnStatus.isVPN ? "safe" : "warning";
  }

  return {
    riskValue: Math.round(riskValue),
    isHomeBroadband: ispAnalysis.isHomeBroadband ? "家宽" : "非家宽",
    isNative: riskValue < 50 ? "原生" : "非原生",
    vpnStatus: vpnStatusText,
    vpnColorKey,
    vpnConfidence: vpnStatus.confidence,
    vpnMethod: vpnStatus.method
  };
}
