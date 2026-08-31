import type { ToolDefinition, ToolboxCapability, ToolboxCategory, ToolId } from "./contracts";

const available: ToolboxCapability = { state: "available", reason: null, platform: null };

const definitions = ([
  ["system-network", "keep-awake", "限时保活", ["防止休眠", "保活"], "在明确期限内保持空闲状态，不修改系统电源计划"],
  ["system-network", "process-watch", "进程退出提醒", ["进程", "退出"], "等待选定进程退出并提醒"],
  ["system-network", "file-occupancy", "文件使用者", ["占用", "句柄"], "诊断谁正在使用文件"],
  ["system-network", "volume-occupancy", "外盘使用者", ["磁盘", "推出"], "诊断可移动卷占用并在确认后推出"],
  ["system-network", "keyboard-cleaning", "键盘清洁", ["键盘", "输入"], "在安全边界内检查键盘输入状态"],
  ["system-network", "schedules", "定时任务", ["提醒", "cron"], "创建只执行提醒或限时保活的本地规则"],
  ["system-network", "network-addresses", "本机地址", ["网卡", "IP", "MAC"], "查看本机网络接口地址和状态"],
  ["system-network", "ifconfig-parser", "ifconfig 解析", ["网络", "掩码"], "在页面内解析粘贴的 BSD/Linux ifconfig 文本"],
  ["text-development", "json", "JSON", ["格式化", "压缩"], "严格校验并保留数字文本和键顺序"],
  ["text-development", "url", "URL", ["百分号", "参数"], "编码、解码和查看 URL 结构"],
  ["text-development", "base64", "Base64", ["Base64URL", "UTF-8"], "转换规定范围内的文本"],
  ["text-development", "time", "时间转换", ["Unix", "ISO", "时区"], "在显式单位和时区之间转换时间"],
  ["text-development", "uuid", "UUID v4", ["随机 ID"], "使用系统安全随机源生成 UUID v4"],
  ["text-development", "qr-code", "二维码", ["QR", "Wi-Fi"], "生成文本、URL 或手填 Wi-Fi 二维码"],
  ["text-development", "text-sha256", "文本 SHA-256", ["hash", "摘要"], "在本机内存中计算文本 SHA-256"],
  ["text-development", "file-sha256", "文件 SHA-256", ["文件 hash", "校验"], "流式读取用户主动选择的单个普通文件"],
  ["text-development", "regex", "正则诊断", ["RegExp", "匹配", "AST"], "诊断 ECMAScript 正则并查看结构"],
  ["text-development", "color", "颜色转换", ["HEX", "OKLCH", "P3"], "转换常见 CSS 颜色格式并提示色域变化"],
  ["image", "image-watermark", "图片水印", ["Logo", "PNG", "JPEG"], "给本地图片添加文字或 Logo 水印"],
  ["image", "image-batch-watermark", "批量水印", ["ZIP", "批处理"], "顺序处理多张图片并导出受控 ZIP"],
  ["image", "confidential-watermark", "保密水印", ["内部", "预设"], "使用可编辑的保密水印预设"],
  ["image", "image-recipe", "Recipe 构建器", ["配方", "JSON"], "校验、迁移和预览图片处理 Recipe"],
  ["image", "image-editor", "图层编辑器", ["图层", "撤销"], "编辑图层并渲染真实本地素材"],
  ["image", "invisible-watermark-write", "隐形水印写入", ["locator", "密钥"], "写入短 locator 并导出不含密钥的记录"],
  ["image", "invisible-watermark-check", "隐形水印检测", ["检测", "恢复"], "用相同算法检查 Image Marker locator"],
  ["image", "recipient-tracking", "收件人追踪包", ["收件人", "分发"], "生成分发图片和私有映射"],
  ["image", "robustness-lab", "稳健性实验室", ["JPEG", "缩放", "裁剪"], "在明确条件下测试 locator 恢复"],
  ["image", "c2pa-inspector", "C2PA 检查器", ["manifest", "凭据"], "离线查看本地嵌入的 C2PA manifest"],
  ["file-patch", "binary-patch-create", "生成补丁", ["BSDIFF43", "差分"], "生成并还原验证二进制补丁"],
  ["file-patch", "binary-patch-apply", "应用与验证", ["应用", "校验"], "应用补丁但绝不覆盖源文件"],
  ["file-patch", "binary-patch-inspector", "补丁检查器", ["头部", "载荷"], "检查补丁格式和边界"],
  ["file-patch", "integrity-manifest", "完整性清单", ["SHA-256", "清单"], "生成绑定文件摘要的 JSON 清单"],
  ["file-patch", "transfer-savings", "传输节省", ["大小", "比例"], "计算补丁与完整包的传输差异"],
  ["file-patch", "patch-errors", "错误码解释", ["BSDIFF", "诊断"], "解释正式补丁 SDK 的错误码"],
  ["file-patch", "patch-planner", "发布规划器", ["多基线", "发布"], "逐个基线验证并选择补丁或完整包"],
] as const).map(([category, id, title, aliases, description]) => ({
    category: category as ToolboxCategory,
    id: id as ToolId,
    title,
    aliases,
    description,
    capability: available,
    load: async () => undefined,
  })) satisfies ReadonlyArray<Omit<ToolDefinition, "load"> & { load: ToolDefinition["load"] }>;

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = definitions;

export function getToolDefinition(id: ToolId): ToolDefinition {
  const definition = TOOL_DEFINITIONS.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Unknown toolbox tool: ${id}`);
  return definition;
}

export function searchTools(query: string): ToolDefinition[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...TOOL_DEFINITIONS];
  return TOOL_DEFINITIONS.filter((tool) => [tool.title, tool.description, ...tool.aliases]
    .some((value) => value.toLocaleLowerCase().includes(needle)));
}
