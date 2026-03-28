export function anthropicToOpenAI(body: any): any {
  const req: any = {
    model: body.model,
    max_tokens: body.max_tokens || 4096,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: !!body.stream,
    messages: []
  };

  if (body.system) {
    req.messages.push({ role: "system", content: typeof body.system === "string" ? body.system : JSON.stringify(body.system) });
  }

  for (const m of (body.messages || [])) {
    if (m.role === "user" || m.role === "assistant") {
      let textContent = "";
      const toolCalls: any[] = [];
      const toolResults: any[] = [];

      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === "text") {
            textContent += block.text;
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input)
              }
            });
          } else if (block.type === "tool_result") {
            toolResults.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content: block.content
            });
          }
        }
      } else if (typeof m.content === "string") {
        textContent = m.content;
      }

      if (toolResults.length > 0) {
        req.messages.push(...toolResults);
      } else {
        const msg: any = { role: m.role, content: textContent };
        if (toolCalls.length > 0) {
           msg.tool_calls = toolCalls;
        }
        req.messages.push(msg);
      }
    }
  }

  if (body.tools && body.tools.length > 0) {
    req.tools = body.tools.map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema
      }
    }));
  }

  return req;
}
