# Protoflux 高性能 AI 协议网关

Protoflux 是一款基于 **Bun + TypeScript** 构建的轻量级、生产级 AI 网关。它专注于实现 OpenAI 与 Anthropic (Claude) 协议之间的无缝转译，支持多层流式解析与自动工具调用恢复。

---

## 🌟 核心特性

- **🚀 生产级流式稳定性**：采用 **SSE 行缓冲 (Line Buffering)** 技术，彻底解决 TCP 拆包导致的 JSON 截断问题，确保流式输出永不断流。
- **🔄 双向工具名映射 (Bidirectional Mapping)**：自动将复杂的 MCP 工具名重写为模型友好的基名，并在回传时确定性还原，完美兼容 Claude Code。
- **🧠 推理过程提取**：内置 XML 状态机，可实时提取并转发 `<thought>` 或 `<thinking>` 标签中的推理内容，提升 UI 交互体验。
- **🛠️ 自动 Schema 转译**：支持将 Anthropic 格式的工具定义 (`input_schema`) 自动转写为 OpenAI 格式 (`type: function`)，支持 GLM-5 等多种上游模型。
- **🔌 零延迟插件系统**：基于 **Stream Lexer** 架构，在流式转发的同时进行 XML 标签剥离与工具封装，实现真正的零首包延迟。
- **📦 广泛的服务商支持**：内置对 OpenAI, Aliyun DashScope, 以及 **AWS Bedrock** 的深度适配，支持 Bedrock 上的原生工具调用流。

---

## 🏗️ 架构概览

```mermaid
graph TD
    Client["客户端 (Claude Code / OpenAI SDK)"] --> Gateway[Protoflux 网关层]
    Gateway --> Buffer[SSE Line Buffer]
    Buffer --> Translator[协议转换层 /protocols]
    Translator --> Lexer[Stream Lexer /plugins]
    Lexer --> Provider[上游提供商 /providers]
    
    subgraph Upstream Providers
        Provider --> OpenAI[OpenAI API]
        Provider --> DashScope[Aliyun DashScope]
        Provider --> Bedrock[AWS Bedrock (Streaming Support)]
    end
```

---

## 🛠️ 快速开始

### 1. 环境准备
- **运行时**: [Bun](https://bun.sh/) 1.0+
- **操作系统**: Linux / macOS

### 2. 安装依赖
```bash
bun install
```

### 3. 配置
复制并编辑 `.env` 文件：
```bash
cp .env.example .env
```
示例配置 (`PROTOFLUX_MODEL_URIS`)：
```env
# 格式: 协议://[发布模型名]/[上游模型名]/[BaseURL]/[凭据]/[插件列表]
PROTOFLUX_MODEL_URIS=dashscope://[claude-sonnet]/[qwen-max]/[https://dashscope.aliyuncs.com/api/v1]/[your-api-key]/[xml-tool-call]
```

### 4. 运行
```bash
# 开发模式
bun run dev

# 调试模式 (输出所有 Payload 详情)
bun run debug

# 运行测试
bun test
```

---

## 📜 高级特性指南

### 确定性工具映射
针对 Claude Code 接入的 MCP 工具（如 `mcp__acp__Read`），Protoflux 会执行：
1. **入站重写**：将工具名简化为 `Read` 传给模型，降低 Tool Payload 长度，提高响应准确度。
2. **出站还原**：利用入站注册表，将模型返回的 `Read` 确定性还原为 `mcp__acp__Read` 返还给客户端。

### XML 推理与工具拆分 (`xml-tool-call`)
该插件采用状态机 Lexer，支持：
- **`<thought>` 标签提取**：将模型的思考过程实时映射为 Anthropic 协议的 `thought` 块。
- **混合内容解析**：支持模型在同一回复中混合输出思考、普通文本和多个 XML 工具调用。

---

## 🧪 单元测试
项目建立了严谨的测试体系，确保协议转换的 100% 一致性：
- **`tests/config.test.ts`**: 验证复杂的 URI 解析逻辑。
- **`tests/lexer.test.ts`**: 验证 XML 词法分析器的鲁棒性。
- **`tests/translator.test.ts`**: 验证 SSE 事件流的转译精准度。

---

## 📄 开源协议
本项目采用 [Apache License 2.0](LICENSE)。
