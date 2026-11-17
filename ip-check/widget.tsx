import { VStack, Text, Widget, VirtualNode, Image, HStack, Spacer, Button, modifiers, fetch, Path } from "scripting";
import { fetchIPInfo, fetchChinaIP, calculateRiskValue, IPInfo } from "./utils/ip";
import { RefreshIPIntent } from "./app_intents";

export interface WidgetProps {
  ipInfo: IPInfo | null;
  riskValue: number;
  isHomeBroadband: string;
  isNative: string;
  vpnStatus: string;
  vpnColorKey?: "safe" | "warning" | "secondary";
  countryFlagPath?: string;
}

const COLORS = {
  safe: "#34C759",
  warning: "#FF9500",
  danger: "#FF3B30",
  secondary: "#8E8E93",
  border: "#3A3A3C",
  white: "#FFFFFF",
  black: "#000000",
} as const;

function WidgetView({ ipInfo, riskValue, isHomeBroadband, isNative, vpnStatus, vpnColorKey, countryFlagPath }: WidgetProps): VirtualNode {
  if (!ipInfo) {
    return (
      <VStack alignment="center" spacing={4} safeAreaPadding={10}>
        <Text foregroundStyle={COLORS.danger as any}>无法获取 IP 数据</Text>
      </VStack>
    );
  }

  const { query: ip, country, city, isp } = ipInfo;
  const location = `${country ?? "未知"} · ${city ?? ""}`.trim();
  const riskColor = riskValue > 60 ? COLORS.danger : (riskValue > 20 ? COLORS.warning : COLORS.safe);

  const vpnOn = vpnStatus !== "未连接" && vpnStatus !== "未知";
  const vpnText = vpnStatus === "已连接" ? "VPN 已连接" : (vpnStatus === "未连接" ? "VPN 未连接" : vpnStatus);
  const vpnColor = !vpnOn ? COLORS.secondary : (vpnColorKey === "warning" ? COLORS.warning : COLORS.safe);

  return (
    <Button
      intent={RefreshIPIntent(undefined)}
      buttonStyle="plain"
      modifiers={modifiers()
        .widgetBackground("clear" as any)
        .ignoresSafeArea()
        .frame({ maxWidth: "infinity", maxHeight: "infinity" })
      }
    >
      <VStack spacing={10} safeAreaPadding={12} alignment="center">
        <Spacer />
        {/* 1. 地球仪图标 + VPN/代理状态 */}
        <HStack spacing={6} alignment="center">
          <Image systemName="globe" font={14} foregroundStyle={vpnColor as any} />
          <Text font={14} fontWeight="medium" foregroundStyle={vpnColor as any}>
            {vpnText}
          </Text>
        </HStack>

        {/* 2. IP 地址 */}
        <Text font={28} bold lineLimit={1} minScaleFactor={0.7} foregroundStyle="label">{ip}</Text>

        {/* 3. 国旗 (PNG方案，原生裁切) + IP 地理位置 */}
        <HStack spacing={8} alignment="center">
          {countryFlagPath ? (
            <Image
              filePath={countryFlagPath}
              frame={{ width: 18, height: 18 }}
              resizable={true}
              clipShape="circle"
              widgetAccentedRenderingMode="fullColor"
            />
          ) : (
            <Text font={16} foregroundStyle="label">📍</Text>
          )}
          <Text font={14} fontWeight="semibold" lineLimit={1} minScaleFactor={0.8} foregroundStyle="label">{location}</Text>
        </HStack>

        {/* 4. 机房名字 */}
        <Text font={12} foregroundStyle={COLORS.secondary as any} lineLimit={1} minScaleFactor={0.8}>
          {isp ?? "未知网络"}
        </Text>

        {/* 5. 状态汇总行 (风险汇总) */}
        <HStack spacing={4} alignment="center">
          <Text font={11} bold foregroundStyle={(isNative === "原生" ? COLORS.safe : COLORS.warning) as any}>
            {isNative}
          </Text>
          <Text font={11} foregroundStyle={COLORS.border as any}>·</Text>
          <Text font={11} bold foregroundStyle={(isHomeBroadband === "家宽" ? COLORS.safe : COLORS.secondary) as any}>
            {isHomeBroadband}
          </Text>
          <Text font={11} foregroundStyle={COLORS.border as any}>·</Text>
          <HStack spacing={2} alignment="bottom">
            <Text font={11} bold foregroundStyle={riskColor as any} minScaleFactor={0.8}>{riskValue}%</Text>
            <Text font={9} foregroundStyle={COLORS.secondary as any}>风险</Text>
          </HStack>
        </HStack>
        <Spacer />
      </VStack>
    </Button>
  );
}

/**
 * 异步下载并缓存国旗 PNG
 */
async function getFlagLocalPath(countryCode: string): Promise<string | undefined> {
  if (!countryCode) return undefined;

  try {
    const flagUrl = `https://flagsapi.com/${countryCode.toUpperCase()}/flat/64.png`;
    const cacheDir = Path.join(FileManager.appGroupDocumentsDirectory, "flags_png");
    const localPath = Path.join(cacheDir, `${countryCode.toUpperCase()}.png`);

    if (!FileManager.existsSync(cacheDir)) {
      FileManager.createDirectorySync(cacheDir, true);
    }

    if (!FileManager.existsSync(localPath)) {
      const response = await fetch(flagUrl);
      if (response.ok) {
        const data = await response.data();
        FileManager.writeAsDataSync(localPath, data);
      }
    }

    return FileManager.existsSync(localPath) ? localPath : undefined;
  } catch (e) {
    console.error("[Widget] 国旗处理失败", e);
    return undefined;
  }
}

async function getWidgetProps(): Promise<WidgetProps> {
  // 并行获取国内IP和国际IP信息
  const [ipInfo, chinaIP] = await Promise.all([
    fetchIPInfo(),
    fetchChinaIP()
  ]);

  if (!ipInfo) {
    return {
      ipInfo: null,
      riskValue: 0,
      isHomeBroadband: "未知",
      isNative: "未知",
      vpnStatus: "未知",
      vpnColorKey: "secondary",
      countryFlagPath: undefined,
    };
  }

  // 传入国内IP进行对比检测
  const { riskValue, isHomeBroadband, isNative, vpnStatus, vpnColorKey } = calculateRiskValue(ipInfo, chinaIP);

  // 台湾特殊映射处理
  let countryCode = ipInfo.countryCode;
  if (ipInfo.country.includes("台湾") && ipInfo.countryCode === "CN") {
    countryCode = "TW";
  }

  const countryFlagPath = await getFlagLocalPath(countryCode);

  return {
    ipInfo,
    riskValue,
    isHomeBroadband,
    isNative,
    vpnStatus,
    vpnColorKey,
    countryFlagPath,
  };
}

export async function renderIPWidget() {
  const widgetProps = await getWidgetProps();
  return <WidgetView {...widgetProps} />;
}

// 自动执行以进行预览/测试
renderIPWidget().then(view => Widget.present(view));