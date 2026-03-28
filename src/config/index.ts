import type { Config, UpstreamConfig, ModelConfig, RouteRule, UpstreamProtocol } from "./types.ts";
import { readFileSync, existsSync } from "fs";

/**
 * 加载 Protoflux 配置的主入口函数。
 * 优先级说明：
 * 1. 优先从环境变量中读取基本信息。
 * 2. 如果根目录下存在 .env 文件，则手动解析该文件。
 *    注意：这里采用手动解析而非标准 dotenv 库，是为了优雅地支持同一个 Key（如 PROTOFLUX_MODEL_URIS）在多行出现的情况。
 */
export function loadConfig(): Config {
  let rawModels = process.env.PROTOFLUX_MODEL_URIS || "";
  let rawRoutes = process.env.PROTOFLUX_ROUTING_RULES || "";

  // 手动读取 .env 文件以支持多行重复的 Key（这在配置大量模型映射时非常有用）
  if (existsSync(".env")) {
    const envContent = readFileSync(".env", "utf-8");
    const modelUris: string[] = [];
    const routeRules: string[] = [];
    
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      // 跳过注释行和空行
      if (!trimmed || trimmed.startsWith("#")) continue;

      if (trimmed.startsWith("PROTOFLUX_MODEL_URIS=")) {
        const val = trimmed.substring("PROTOFLUX_MODEL_URIS=".length).trim();
        if (val) modelUris.push(val);
      }
      if (trimmed.startsWith("PROTOFLUX_ROUTING_RULES=")) {
        const val = trimmed.substring("PROTOFLUX_ROUTING_RULES=".length).trim();
        if (val) routeRules.push(val);
      }
    }
    
    // 如果 .env 中定义了内容，则合并/覆盖环境变量的内容
    if (modelUris.length > 0) {
      rawModels = modelUris.join("\n");
    }
    if (routeRules.length > 0) {
      rawRoutes = routeRules.join("\n");
    }
  }

  // 解析路由优先级规则
  const routes = parseRoutes(rawRoutes);
  // 解析核心的模型 URI 映射
  const { upstreams, models } = parseModelUris(rawModels);

  // 基础校验：必须至少定义一个可用的模型映射
  if (models.length === 0) {
    throw new Error("PROTOFLUX_MODEL_URIS is required and must contain at least one valid entry");
  }

  const config: Config = {
    host: process.env.PROTOFLUX_HOST || "0.0.0.0",
    port: parseInt(process.env.PROTOFLUX_PORT || "8080", 10),
    upstreams,
    models,
    modelById: {},
    routes,
  };

  // 执行二次校验并建立模型 ID 索引以便快速查表
  validateAndIndex(config);
  return config;
}

/**
 * 将 JSON 字符串解析为路由规则数组。
 * 路由规则用于根据请求的模型名决定转发到哪个上游。
 */
function parseRoutes(raw: string): RouteRule[] {
  if (!raw.trim()) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * 校验已加载的配置，并创建以模型 ID 为 Key 的索引表。
 * 同时会检查路由规则中引用的上游是否存在。
 */
function validateAndIndex(config: Config) {
  const index: Record<string, ModelConfig> = {};
  
  // 检查路由关联的上游有效性
  for (const r of config.routes) {
    if (!r.upstream) throw new Error(`Route error: upstream is empty for match=${r.match}`);
    if (!config.upstreams[r.upstream]) throw new Error(`Route error: unknown upstream: ${r.upstream}`);
  }

  // 遍历所有模型，检查必填项并建立索引
  for (const m of config.models) {
    if (!m.id) throw new Error("Model error: model id is empty");
    if (!m.upstream) throw new Error(`Model ${m.id} error: upstream is empty`);
    if (index[m.id]) throw new Error(`Model conflict: duplicate model id: ${m.id}`);
    
    const u = config.upstreams[m.upstream];
    if (!u) throw new Error(`Model ${m.id} references unknown upstream: ${m.upstream}`);
    
    // 如果未显式指定上游模型名 (upstreamModel)，则默认使用上游的 defaultModel 或发布出来的 ID 
    if (!m.upstreamModel) {
       m.upstreamModel = u.defaultModel || (m.id as string);
    }
    index[m.id] = m;
  }
  config.modelById = index;
}

/**
 * 解析复杂的 PROTOFLUX_MODEL_URIS 字符串。
 * 格式标准: 协议://[发布模型ID]/[上游模型ID]/[基础URL]/[认证凭据]/[可选插件列表]
 * 示例: dashscope://[claude-sonnet]/[qwen-max]/[https://dashscope.aliyuncs.com/v1]/[sk-xxxx]/[xml-tool-call]
 */
function parseModelUris(raw: string) {
  const upstreams: Record<string, UpstreamConfig> = {};
  const models: ModelConfig[] = [];
  if (!raw.trim()) return { upstreams, models };

  // 使用状态机思想切分条目，确保能正确处理嵌套在 [] 内部的换行或分隔符
  const entries: string[] = [];
  let buffer = "";
  let insideBrackets = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '[') insideBrackets++;
    else if (char === ']') insideBrackets--;

    // 在 [] 外部遇到换行、逗号或分号，则认为是一个条目的结束
    if (insideBrackets === 0 && (char === '\n' || char === ',' || char === ';')) {
      const trimmed = buffer.trim();
      if (trimmed) entries.push(trimmed);
      buffer = "";
    } else {
      buffer += char;
    }
  }
  const finalTrimmed = buffer.trim();
  if (finalTrimmed) entries.push(finalTrimmed);

  // 用于复用相同凭据的上游配置，避免重复创建上游实例
  const upstreamByKey: Record<string, string> = {};

  entries.forEach((entry, idx) => {
    const sepIdx = entry.indexOf("://");
    if (sepIdx < 0) return;
    
    const protocol = entry.substring(0, sepIdx).trim() as UpstreamProtocol;
    const rest = entry.substring(sepIdx + 3);

    // 解析 [] 包裹的各个片段
    const segments = parseBracketedSegments(rest);
    if (!segments || (segments.length !== 4 && segments.length !== 5)) return;

    const publishModel = segments[0]?.trim();
    let upstreamModel = segments[1]?.trim();
    const baseUrl = segments[2]?.trim();
    const cred = segments[3]?.trim();
    const plugins = segments.length === 5 ? parsePlugins(segments[4] || "") : [];

    // 校验：publishModel 必须存在；baseUrl 对 Bedrock 协议可以为空（SDK 自动推导 Endpoint）
    if (!publishModel) return;
    if (!upstreamModel) upstreamModel = publishModel;

    // 处理认证信息（支持纯 API Key 或 AWS 风格的 AK/SK）
    let region, ak, sk, apiKey;
    if (isAKSK(cred || "")) {
       [region, ak, sk] = parseAKSK(cred || "");
    } else {
       apiKey = cred;
    }

    // 根据协议、URL 和凭据生成唯一键，实现上游配置的去重与复用
    const key = `${protocol}|${baseUrl}|${apiKey || ''}|${region || ''}|${ak || ''}`;
    let upstreamName = upstreamByKey[key];
    
    if (!upstreamName) {
      // 自动生成上游名，例如 dashscope_1
      upstreamName = `${sanitize(protocol)}_${idx + 1}`;
      upstreams[upstreamName] = {
        name: upstreamName,
        protocol,
        baseUrl: baseUrl || "",
        apiKey,
        region,
        accessKey: ak,
        secretKey: sk,
        defaultModel: upstreamModel
      };
      upstreamByKey[key] = upstreamName;
    }

    // 记录模型映射关系
    models.push({
      id: publishModel,
      upstream: upstreamName,
      upstreamModel,
      plugins,
    });
  });

  return { upstreams, models };
}

/**
 * 辅助函数：从格式如 [seg1]/[seg2]/... 的字符串中提取各段内容。
 * 它能够处理方括号内的特殊字符。
 */
function parseBracketedSegments(s: string): string[] | null {
  s = s.trim();
  if (!s) return null;

  const segments: string[] = [];
  let i = 0;
  const n = s.length;

  while (i < n) {
    // 跳过空格
    while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= n) break;
    
    // 片段必须以 [ 开头
    if (s[i] !== '[') return null;
    i++;
    
    const start = i;
    // 寻找匹配的结束 ]
    while (i < n && s[i] !== ']') i++;
    if (i >= n) return null;
    
    segments.push(s.substring(start, i));
    i++;
    
    // 检查片段之间是否由 / 分隔
    while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= n) break;
    if (s[i] !== '/') return null;
    i++;
  }
  
  return segments.length > 0 ? segments : null;
}

/**
 * 启发式判断凭据字符串是否为 AWS 风格的 AK/SK 格式。
 * 支持 JSON 数组格式 ["region", "ak", "sk"] 或 传统的 : 分隔格式。
 */
function isAKSK(s: string): boolean {
  s = s.trim();
  if (s.startsWith('["') && s.endsWith('"]')) return true; 
  const c1 = s.split(':').length - 1;
  const c2 = s.split('":"').length - 1;
  return c1 === 2 && !s.includes('http');
}

/**
 * 将凭据字符串解析为 [region, accessKey, secretKey] 元组。
 */
function parseAKSK(s: string): [string, string, string] {
  s = s.trim();
  // 处理 JSON 数组格式
  if (s.startsWith('["') && s.endsWith('"]')) {
      try {
          const arr = JSON.parse(s);
          if (Array.isArray(arr) && arr.length === 3) {
              return [arr[0], arr[1], arr[2]];
          }
      } catch (e) {}
  }

  // 处理复杂的引号包裹的冒号分隔格式
  s = s.replace(/^"|"$/g, '');
  let parts = s.split('":"');
  if (parts.length !== 3) {
      parts = s.split(':').map(p => p.trim().replace(/^"|"$/g, ''));
  }
  if (parts.length !== 3) return ["", "", ""];
  return parts as [string, string, string];
}

/**
 * 字符串清洗，确保生成的内部名称符合标识符规范（仅包含字母、数字、下划线）。
 */
function sanitize(s: string): string {
  const res = s.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return res ? res.toLowerCase() : "upstream";
}

/**
 * 解析以 | 分隔的插件列表字符串。
 */
function parsePlugins(raw: string): string[] {
  if (!raw.trim()) return [];
  const parts = raw.split("|");
  const out = new Set<string>();
  for (const p of parts) {
    const name = p.trim().toLowerCase();
    if (name) out.add(name);
  }
  return Array.from(out);
}
