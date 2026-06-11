import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { sanitizeAnthropicMessages } from "../proxy-scripts/src/handlers/parse-request.js";
import { shouldFallbackToChatCompletions, toChatCompletionsMessages, buildOpenAIChatCompletionsBody } from "../proxy-scripts/src/handlers/chat.js";
import { buildGatewayCapabilityKey, clearGatewayCapabilityCache, getGatewayCapability, markGatewayCapability, _getGatewayCapabilityCacheSizeForTests } from "../proxy-scripts/src/handlers/gateway-capability.js";

const require = createRequire(import.meta.url);
const { readClaudeUserConfig, readCodexUserConfig } = require("../externalConfigImporter.js");
const { PatchManager } = require("../patchManager.js");
const gatewayUrl = require("../gatewayUrl.js");

test("sanitizeAnthropicMessages strips unsigned thinking and keeps signed thinking", () => {
  const messages = [{
    role: "assistant",
    content: [{
      type: "thinking",
      thinking: "unsigned"
    }, {
      type: "thinking",
      thinking: "signed",
      signature: "sig"
    }, {
      type: "text",
      text: "done"
    }]
  }];

  const result = sanitizeAnthropicMessages(messages);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].content, [{
    type: "thinking",
    thinking: "signed",
    signature: "sig"
  }, {
    type: "text",
    text: "done"
  }]);
});

test("shouldFallbackToChatCompletions detects unsupported responses gateways", () => {
  assert.equal(shouldFallbackToChatCompletions(500, JSON.stringify({
    error: {
      code: "convert_request_failed",
      message: "not implemented"
    }
  })), true);
  assert.equal(shouldFallbackToChatCompletions(401, "not implemented"), false);
});

test("toChatCompletionsMessages converts tool use and tool result", () => {
  const result = toChatCompletionsMessages("sys", [{
    role: "assistant",
    content: [{
      type: "text",
      text: "calling"
    }, {
      type: "tool_use",
      id: "call_1",
      name: "read_file",
      input: {
        path: "a.txt"
      }
    }]
  }, {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "call_1",
      content: "ok"
    }]
  }]);

  assert.equal(result[0].role, "system");
  assert.equal(result[1].tool_calls[0].function.name, "read_file");
  assert.equal(result[2].role, "tool");
  assert.equal(result[2].tool_call_id, "call_1");
});

test("buildOpenAIChatCompletionsBody can omit Gemini thinking fields", () => {
  const withThinking = buildOpenAIChatCompletionsBody({
    systemPrompt: "",
    messages: [{
      role: "user",
      content: "hello"
    }],
    resolvedModel: "gemini-3.5-flash",
    thinkingOptions: {
      thinkingEnabled: true,
      reasoningEffort: "low"
    },
    forwardTools: false
  });
  const withoutThinking = buildOpenAIChatCompletionsBody({
    systemPrompt: "",
    messages: [{
      role: "user",
      content: "hello"
    }],
    resolvedModel: "gemini-3.5-flash",
    thinkingOptions: {
      thinkingEnabled: true,
      reasoningEffort: "low"
    },
    forwardTools: false,
    omitGeminiThinking: true
  });

  assert.ok(withThinking.thinking_config || withThinking.extra_body);
  assert.equal(withoutThinking.thinking_config, undefined);
  assert.equal(withoutThinking.extra_body, undefined);
});

test("gateway capability cache uses detailed keys and can be cleared", () => {
  clearGatewayCapabilityCache();
  const key = buildGatewayCapabilityKey({
    protocol: "https",
    host: "api.example.com",
    port: 443,
    apiPath: "/v1/responses",
    providerKind: "openai",
    slot: 1
  });

  markGatewayCapability(key, {
    preferChatCompletions: true,
    reason: "responses rejected"
  });

  assert.equal(getGatewayCapability(key).preferChatCompletions, true);
  assert.equal(_getGatewayCapabilityCacheSizeForTests(), 1);
  clearGatewayCapabilityCache();
  assert.equal(getGatewayCapability(key), null);
});

test("gateway URL inference preserves explicit protocol and infers local HTTP", () => {
  assert.equal(gatewayUrl.ensureGatewayUrl("127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(gatewayUrl.ensureGatewayUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(gatewayUrl.ensureGatewayUrl("api.example.com"), "https://api.example.com");
  assert.equal(gatewayUrl.ensureGatewayUrl("http://api.example.com:8080"), "http://api.example.com:8080");
  assert.equal(gatewayUrl.shouldUseHttpGateway("api.example.com:8080"), true);
});

test("external config importer reads Claude and Codex user config files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "byok-import-"));
  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://claude.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-claude",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8"
    }
  }));
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({
    OPENAI_API_KEY: "sk-openai"
  }));
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), [
    "model_provider = \"custom\"",
    "model = \"gpt-5.5\"",
    "",
    "[model_providers.custom]",
    "base_url = \"https://openai.example.com/v1\""
  ].join("\n"));

  const claude = readClaudeUserConfig(home);
  const codex = readCodexUserConfig(home);

  assert.equal(claude.ok, true);
  assert.equal(claude.host, "claude.example.com");
  assert.equal(claude.model, "claude-opus-4-8");
  assert.equal(codex.ok, true);
  assert.equal(codex.host, "openai.example.com/v1");
  assert.equal(codex.model, "gpt-5.5");
});

test("PatchManager recognizes dynamic loopback patch URLs", () => {
  const rules = [{
    name: "P1: mock",
    originalRegex: /([A-Za-z_$][\w$]*)\.getApiServerUrlFromContext=([A-Za-z_$][\w$]*)=>\{return"old"\}/
  }, {
    name: "P2: mock",
    originalRegex: /async restart\(([A-Za-z_$][\w$]*)\)\{this\.apiServerUrl=\1,this\.inputs\.apiServerUrl=\1,/
  }, {
    name: "P3: mock",
    originalRegex: /const ([A-Za-z_$][\w$]*)=oldInference/
  }];
  let content = 'e.getApiServerUrlFromContext=A=>{return"old"}\nasync restart(A){this.apiServerUrl=A,this.inputs.apiServerUrl=A,\nconst i=oldInference';
  content = PatchManager.applyPatchContent(content, rules[0], "http://127.0.0.1:3333", "http://127.0.0.1:4444").content;
  content = PatchManager.applyPatchContent(content, rules[1], "http://127.0.0.1:3333", "http://127.0.0.1:4444").content;
  content = PatchManager.applyPatchContent(content, rules[2], "http://127.0.0.1:3333", "http://127.0.0.1:4444").content;

  assert.match(content, /127\.0\.0\.1:3333/);
  assert.match(content, /127\.0\.0\.1:4444/);
  assert.equal(PatchManager.isPatched(content, rules[0], "http://127.0.0.1:3333", "http://127.0.0.1:4444"), true);
  assert.equal(PatchManager.isPatched(content, rules[2], "http://127.0.0.1:3333", "http://127.0.0.1:4444"), true);
});
