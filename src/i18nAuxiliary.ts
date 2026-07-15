import {
  initialLanguage,
  persistLanguage,
  type SupportedLanguage,
} from "./language";

type TranslationTree = { readonly [key: string]: string | TranslationTree };
type TranslationValues = Record<string, string | number>;
export type AuxiliaryTranslate = (
  key: string,
  values?: TranslationValues,
) => string;

const resources = {
  "zh-CN": {
    common: { unavailable: "不可用" },
    app: { resume: "继续", pause: "暂停", settings: "设置" },
    splash: {
      title: "正在启动 StatusOrbit",
      description: "本机资源状态，清晰呈现。",
      connecting: "正在连接本机采样器",
    },
    tray: {
      localMonitor: "本机资源监控",
      available: "可用空间",
      open: "打开概览",
      companion: "Orbit 伙伴",
      cleanup: "空间清理",
      health: {
        loading: "连接中",
        observing: "正在了解状态",
        normal: "状态正常",
        attention: "需要关注",
        urgent: "建议处理",
      },
      status: {
        loading: { title: "正在读取电脑状态", description: "首个采样结果很快就会出现。" },
        observing: { title: "正在了解电脑状态", description: "再观察一会儿，避免把短暂波动误判成问题。" },
        normal: { title: "电脑运行平稳", description: "没有发现需要立即处理的资源问题。" },
        attention: { title: "有一项资源值得留意", description: "打开 StatusOrbit 可以查看原因和对应建议。" },
        urgent: { title: "有一项资源压力较高", description: "建议打开 StatusOrbit 查看证据后再处理。" },
      },
      reason: "{{resource}}需要关注",
      resource: {
        cpu: "处理器",
        memory: "内存",
        storage: "存储",
        temperature: "温度",
        battery: "电池",
        none: "系统",
      },
    },
    companion: {
      kicker: "Orbit 小伙伴",
      dragHint: "拖动 Orbit 移动；悬停查看状态；右键打开菜单",
      menu: "Orbit 小伙伴菜单",
      hide: "隐藏小伙伴",
      reason: "{{resource}}最近值得留意，可以打开主窗口看看原因。",
      action: {
        loading: "打开日常助手",
        observing: "查看当前状态",
        normal: "我遇到了问题",
        attention: "看看原因",
        urgent: "现在查看",
      },
    },
  },
  en: {
    common: { unavailable: "Unavailable" },
    app: { resume: "Resume", pause: "Pause", settings: "Settings" },
    splash: {
      title: "Starting StatusOrbit",
      description: "Your local system health, made clear.",
      connecting: "Connecting to the local sampler",
    },
    tray: {
      localMonitor: "Local system monitor",
      available: "Available space",
      open: "Open overview",
      companion: "Orbit companion",
      cleanup: "Space cleanup",
      health: {
        loading: "Connecting",
        observing: "Learning status",
        normal: "Healthy",
        attention: "Attention",
        urgent: "Action advised",
      },
      status: {
        loading: { title: "Reading system health", description: "The first sample will appear shortly." },
        observing: { title: "Learning this computer's state", description: "Watching a little longer so a brief spike is not mistaken for a problem." },
        normal: { title: "Your computer is running smoothly", description: "No resource issue needs immediate attention." },
        attention: { title: "One resource is worth watching", description: "Open StatusOrbit to see the reason and guidance." },
        urgent: { title: "One resource is under pressure", description: "Review the evidence in StatusOrbit before taking action." },
      },
      reason: "{{resource}} needs attention",
      resource: {
        cpu: "CPU",
        memory: "Memory",
        storage: "Storage",
        temperature: "Temperature",
        battery: "Battery",
        none: "System",
      },
    },
    companion: {
      kicker: "Orbit companion",
      dragHint: "Drag Orbit to move; hover for status; right-click for menu",
      menu: "Orbit companion menu",
      hide: "Hide companion",
      reason: "{{resource}} has been worth watching recently. Open the main window to see why.",
      action: {
        loading: "Open everyday helper",
        observing: "View current status",
        normal: "I have a problem",
        attention: "See why",
        urgent: "Review now",
      },
    },
  },
} as const satisfies Record<SupportedLanguage, TranslationTree>;

let language = initialLanguage();
const listeners = new Set<() => void>();

export function subscribeAuxiliaryLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAuxiliaryLanguage(): SupportedLanguage {
  return language;
}

export const translateAuxiliary: AuxiliaryTranslate = (key, values = {}) => {
  let value: string | TranslationTree | undefined = resources[language];
  for (const segment of key.split(".")) {
    value = typeof value === "object" ? value[segment] : undefined;
  }
  if (typeof value !== "string") return key;
  return value.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  );
};

export function changeAuxiliaryLanguage(nextLanguage: SupportedLanguage): void {
  persistLanguage(nextLanguage);
  if (language === nextLanguage) return;
  language = nextLanguage;
  for (const listener of listeners) listener();
}

const auxiliaryI18n = {
  changeLanguage(nextLanguage: SupportedLanguage): Promise<void> {
    changeAuxiliaryLanguage(nextLanguage);
    return Promise.resolve();
  },
};

persistLanguage(language);

export default auxiliaryI18n;
