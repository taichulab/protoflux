/**
 * 支持的上游协议类型。
 */
export type UpstreamProtocol = "openai-completions" | "openai" | "openai-response" | "anthropic" | "bedrock";

/**
 * 上游提供商配置。
 * 包含基础 URL、鉴权信息以及默认模型设置。
 */
export interface UpstreamConfig {
  name: string;            // 上游的内部唯一标识名
  protocol: UpstreamProtocol;
  baseUrl: string;         // API 基础 URL
  apiKey?: string;         // 针对 OpenAI/Dashscope 的 API Key
  region?: string;         // 针对 AWS Bedrock 的区域
  accessKey?: string;      // 针对 AWS Bedrock 的 AK
  secretKey?: string;      // 针对 AWS Bedrock 的 SK
  defaultModel: string;    // 如果模型配置中未指定，则默认使用的上游模型 ID
}

/**
 * 发布给客户端的模型配置。
 * 定义了下游模型 ID 到上游模型及插件的映射。
 */
export interface ModelConfig {
  id: string;              // 发布出去的模型 ID（客户端请求时使用的 ID）
  upstream: string;        // 关联的上游标识名
  upstreamModel: string;   // 在上游服务商处真实的模型 ID
  plugins: string[];       // 该模型启用的插件列表（如 xml-tool-call）
}

/**
 * 基础路由规则（待扩展）。
 */
export interface RouteRule {
  match: string;
  upstream: string;
  model: string;
}

/**
 * 全局配置对象。
 */
export interface Config {
  host: string;
  port: number;
  upstreams: Record<string, UpstreamConfig>;
  models: ModelConfig[];
  modelById: Record<string, ModelConfig>;
  routes: RouteRule[];
}

