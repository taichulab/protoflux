import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { loadConfig } from "../src/config";
import { existsSync, renameSync } from "fs";

describe("Config Loader", () => {
  const originalEnv = process.env.PROTOFLUX_MODEL_URIS;
  const envPath = ".env";
  const envBakPath = ".env.test_bak";

  beforeAll(() => {
    // Isolate from local .env
    if (existsSync(envPath)) {
      renameSync(envPath, envBakPath);
    }
    process.env.PROTOFLUX_MODEL_URIS = "openai://[claude-sonnet]/[qwen-plus]/[https://dashscope.aliyuncs.com/api/v1]/[your_token]/[xml_toolcall]";
  });

  afterAll(() => {
    process.env.PROTOFLUX_MODEL_URIS = originalEnv;
    // Restore local .env
    if (existsSync(envBakPath)) {
      renameSync(envBakPath, envPath);
    }
  });

  test("should parse multiple model URIs correctly", () => {
    const cfg = loadConfig();
    expect(cfg.models.length).toBeGreaterThanOrEqual(1);
    expect(cfg.modelById["claude-sonnet"]).toBeDefined();
    
    const sonnet = cfg.modelById["claude-sonnet"]!;
    expect(sonnet.upstream).toBeDefined();
    expect(sonnet.plugins).toContain("xml_toolcall");
  });

  test("should parse openai upstream correctly", () => {
    const cfg = loadConfig();
    const model = cfg.modelById["claude-sonnet"]!;
    const upstream = cfg.upstreams[model.upstream]!;
    expect(upstream.protocol).toBe("openai");
    expect(upstream.baseUrl).toBe("https://dashscope.aliyuncs.com/api/v1");
    expect(upstream.apiKey).toBe("your_token");
  });
});
