# 插件开发指南 (Bun + TypeScript)

本文档说明 Protoflux 的插件机制、执行时机以及如何基于 **Stream Lexer** 架构开发自定义解析插件。

## 1. 架构目标

- **流式处理**: 插件直接作用于上游返回的每一份数据块（Chunk），不引入额外延迟。
- **解耦设计**: Providers 负责获取数据流，Lexer 插件负责内容识别，Translator 负责协议拼装。
- **状态维护**: 插件支持跨 Chunk 的状态维护（如 XML 标签跨包匹配）。

## 2. 核心接口：StreamLexer

在 Protoflux 中，支持流式解析的插件需要实现 `StreamLexer` 接口（详见 `src/plugins/xml-tool-call-stream.ts`）：

```typescript
export type LexerResult = 
  | { type: "text"; text: string }             // 普通文本内容
  | { type: "thought"; text: string }          // 推理过程内容
  | { type: "tool_call_start"; id: string; name: string; index: number } // 工具调用开始
  | { type: "tool_call_delta"; id: string; text: string }                // 工具参数增量
  | { type: "tool_call_stop"; id: string };                             // 工具调用结束

export interface StreamLexer {
  process(chunk: string): LexerResult[];       // 处理一个增量文本块
  reset(): void;                               // 重置状态机（可选）
}
```

## 3. 执行链路

1. **Messages Route**: 接收上游 Response。
2. **Line Buffer**: 确保 SSE 行完整性。
3. **Loop**: 对每一行 JSON `delta.content` 调用 `lexer.process(content)`。
4. **Broadcast**: 将 `LexerResult[]` 传给 `OpenAIToAnthropicTranslator` 进行协议转换。

## 4. 内置插件：xml-tool-call (XML 状态机)

这是项目中最核心的插件，其功能包括：

- **推理块提取**: 识别 `<thought>` 或 `<thinking>` 标签，输出 `type: "thought"` 结果。
- **XML 工具提取**: 识别 `<tool_call>` 标签。
    - **自动映射**: 支持内联属性解析，如 `<tool_call name="Read" path="test.ts" />`。
    - **长文本支持**: 支持参数中的三引号 `"""`。

## 5. 开发建议

- **避免正则依赖**: 全文正则解析在流式环境下会失效。应使用类似 `XMLStreamLexer` 的字符级状态机。
- **轻量化**: 插件运行在流处理的热路径上，应避免复杂的对象分配。
- **冪等性**: `reset()` 方法应能确实清空所有缓冲区，防止上一个请求的残留影响下一个请求。

## 6. 注册与启用

1. 在 `src/plugins/` 下创建新的 Lexer。
2. 在 `src/routes/messages.ts` 的流处理循环中引入。
3. 通过 `PROTOFLUX_MODEL_URIS` 的第五段配置启用，例如：`.../[xml-tool-call]`。
