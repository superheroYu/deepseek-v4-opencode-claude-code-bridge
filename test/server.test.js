const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cachePath = path.join(
  os.tmpdir(),
  `deepseek-v4-opencode-claude-code-bridge-test-${process.pid}.json`,
);

process.env.CLAUDE_OPENCODE_REASONING_CACHE = cachePath;

const bridge = require("../server.js");

test.after(() => {
  bridge.flushReasoningCache();
  fs.rmSync(cachePath, { force: true });
  fs.rmSync(`${cachePath}.tmp`, { force: true });
});

test("anthropicToOpenAi converts messages, tools, and DeepSeek reasoning", () => {
  bridge.setToolReasoning("toolu_1", "reasoning for tool call");

  const payload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-pro[1m]",
      system: "You are concise.",
      max_tokens: 128,
      messages: [
        { role: "user", content: "Read a file." },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect it." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Read",
              input: { file_path: "README.md" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "file contents" }],
            },
          ],
        },
      ],
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: { file_path: { type: "string" } },
            required: ["file_path"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "Read" },
    },
    false,
  );

  assert.equal(payload.model, "deepseek-v4-pro[1m]");
  assert.equal(payload.stream, false);
  assert.equal(payload.messages[0].role, "system");
  assert.match(payload.messages[0].content, /You are concise/);
  assert.match(payload.messages[0].content, /Call the available tool named "Read"/);
  assert.equal(payload.messages[2].role, "assistant");
  assert.equal(payload.messages[2].reasoning_content, "reasoning for tool call");
  assert.equal(payload.messages[2].tool_calls[0].function.name, "Read");
  assert.equal(payload.messages[3].role, "tool");
  assert.equal(payload.messages[3].tool_call_id, "toolu_1");
  assert.equal(payload.tools[0].function.name, "Read");
  assert.equal(payload.tool_choice, undefined);
});

test("openAiToAnthropic converts text and tool calls", () => {
  const message = bridge.openAiToAnthropic(
    {
      id: "chatcmpl_1",
      model: "deepseek-v4-pro[1m]",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "I need a file.",
            reasoning_content: "reasoning for response",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "Read",
                  arguments: "{\"file_path\":\"README.md\"}",
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
    "deepseek-v4-pro[1m]",
  );

  assert.equal(message.id, "chatcmpl_1");
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.usage, { input_tokens: 10, output_tokens: 5 });
  assert.deepEqual(message.content[0], {
    type: "thinking",
    thinking: "reasoning for response",
    signature: "",
  });
  assert.deepEqual(message.content[1], { type: "text", text: "I need a file." });
  assert.deepEqual(message.content[2], {
    type: "tool_use",
    id: "call_1",
    name: "Read",
    input: { file_path: "README.md" },
  });
});

test("upstreamResponseHeaders keeps only safe response headers", () => {
  const headers = new Headers({
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "set-cookie": "secret=value",
    server: "upstream",
  });

  assert.deepEqual(bridge.upstreamResponseHeaders(headers), {
    "access-control-allow-origin": "*",
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
});

test("expandHome handles Windows and POSIX home-relative paths", () => {
  assert.equal(bridge.expandHome("~/cache.json"), path.join(os.homedir(), "cache.json"));
  assert.equal(bridge.expandHome("~\\cache.json"), path.join(os.homedir(), "cache.json"));
});

test("currentToolContextParts tracks the latest active tool context", () => {
  assert.deepEqual(
    bridge.currentToolContextParts([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file_path: "README.md" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "contents",
          },
        ],
      },
    ]),
    [
      'tool_use:toolu_1:Read:{"file_path":"README.md"}',
      "tool_result:toolu_1:contents",
    ],
  );
});

test("mapFinishReason covers known values", () => {
  assert.equal(bridge.mapFinishReason("tool_calls"), "tool_use");
  assert.equal(bridge.mapFinishReason("length"), "max_tokens");
  assert.equal(bridge.mapFinishReason("stop"), "end_turn");
  assert.equal(bridge.mapFinishReason(null), "end_turn");
});

test("streamOpenAiAsAnthropic emits message_stop and usage", async () => {
  async function* body() {
    yield Buffer.from(
      'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
      "utf8",
    );
    yield Buffer.from(
      'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
      "utf8",
    );
    yield Buffer.from(
      'data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      "utf8",
    );
    yield Buffer.from("data: [DONE]\n\n", "utf8");
  }

  const writes = [];
  const res = {
    destroyed: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk) {
      writes.push(String(chunk));
    },
    end() {
      this.writableEnded = true;
    },
  };

  await bridge.streamOpenAiAsAnthropic({ body: body() }, res, "deepseek-v4-pro[1m]");

  const output = writes.join("");
  assert.equal(res.status, 200);
  assert.match(output, /"type":"thinking"/);
  assert.match(output, /"type":"thinking_delta"/);
  assert.match(output, /"thinking":"thinking\.\.\."/);
  assert.match(output, /event: content_block_delta/);
  assert.match(output, /"text":"OK"/);
  assert.match(output, /event: message_delta/);
  assert.match(output, /"output_tokens":2/);
  assert.match(output, /event: message_stop/);
  assert.equal(res.writableEnded, true);
});

test("createServer returns 400 for malformed JSON", async () => {
  const server = bridge.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "unused",
      },
      body: "{bad json",
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error.type, "invalid_request_error");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("tool_choice auto is passed through while DeepSeek forced tool choice is softened", () => {
  const autoPayload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-pro[1m]",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "auto" },
    },
    false,
  );
  assert.equal(autoPayload.tool_choice, "auto");

  const nonDeepSeekPayload = bridge.anthropicToOpenAi(
    {
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "tool", name: "Read" },
    },
    false,
  );
  assert.deepEqual(nonDeepSeekPayload.tool_choice, {
    type: "function",
    function: { name: "Read" },
  });
});

test("Claude Code thinking and effort fields are translated from the request body", () => {
  const payload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-pro[1m]",
      messages: [{ role: "user", content: "think deeply" }],
      thinking: { type: "enabled", budget_tokens: 4096 },
      output_config: { effort: "max" },
    },
    false,
  );

  assert.deepEqual(payload.thinking, { type: "enabled" });
  assert.equal(payload.reasoning_effort, "max");

  const highPayload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-pro[1m]",
      messages: [{ role: "user", content: "think" }],
      output_config: { effort: "xhigh" },
    },
    false,
  );

  assert.equal(highPayload.reasoning_effort, "max");
});

test("thinking and reasoning_effort are not sent to non-DeepSeek models", () => {
  const payload = bridge.anthropicToOpenAi(
    {
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "think deeply" }],
      thinking: { type: "enabled" },
      output_config: { effort: "max" },
    },
    false,
  );

  assert.equal(payload.thinking, undefined);
  assert.equal(payload.reasoning_effort, undefined);
});

test("Claude Code thinking blocks are restored as DeepSeek reasoning_content", () => {
  const payload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-pro[1m]",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "visible reasoning from Claude Code history",
              signature: "",
            },
            {
              type: "tool_use",
              id: "toolu_thinking",
              name: "Read",
              input: { file_path: "README.md" },
            },
          ],
        },
      ],
    },
    false,
  );

  assert.equal(payload.messages[0].reasoning_content, "visible reasoning from Claude Code history");
});

test("assistant content is null when a tool call has no text", () => {
  const payload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-pro[1m]",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_empty",
              name: "Read",
              input: { file_path: "README.md" },
            },
          ],
        },
      ],
    },
    false,
  );

  assert.equal(payload.messages[0].content, null);
  assert.equal(payload.messages[0].tool_calls[0].function.name, "Read");
});

test("reasoningFromMessage supports aliases", () => {
  assert.equal(bridge.reasoningFromMessage({ reasoning: "r1" }), "r1");
  assert.equal(bridge.reasoningFromMessage({ reasoning: { content: "r2" } }), "r2");
  assert.equal(bridge.reasoningFromMessage({ thinking: "t1" }), "t1");
  assert.equal(bridge.reasoningFromMessage({ thinking: { content: "t2" } }), "t2");
});

test("reasoning cache persists tool reasoning across reload", () => {
  bridge.setToolReasoning("persisted_tool", "persisted reasoning");
  assert.equal(bridge.saveReasoningCacheNow(), true);

  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(cache.version, 2);
  assert.equal(cache.toolCallReasoning.persisted_tool.reasoning, "persisted reasoning");
  assert.equal(typeof cache.toolCallReasoning.persisted_tool.updatedAt, "number");

  bridge.loadReasoningCache();
  assert.equal(bridge.getToolReasoning("persisted_tool"), "persisted reasoning");
});

test("reasoning cache loads legacy strings and skips expired entries", () => {
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      toolCallReasoning: {
        legacy_tool: "legacy reasoning",
        expired_tool: {
          reasoning: "expired reasoning",
          updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
        },
      },
    }),
    "utf8",
  );

  bridge.loadReasoningCache();
  assert.equal(bridge.getToolReasoning("legacy_tool"), "legacy reasoning");
  assert.equal(bridge.getToolReasoning("expired_tool"), null);
});

test("reasoning cache trims oldest entries to fit max serialized size", () => {
  const originalCachePath = process.env.CLAUDE_OPENCODE_REASONING_CACHE;
  const originalMaxSize = process.env.CLAUDE_OPENCODE_REASONING_CACHE_MAX_SIZE_BYTES;
  const originalMaxAge = process.env.CLAUDE_OPENCODE_REASONING_CACHE_MAX_AGE_MS;
  const sizeCachePath = path.join(
    os.tmpdir(),
    `deepseek-v4-opencode-claude-code-bridge-size-${process.pid}.json`,
  );
  const serverPath = require.resolve("../server.js");

  try {
    process.env.CLAUDE_OPENCODE_REASONING_CACHE = sizeCachePath;
    process.env.CLAUDE_OPENCODE_REASONING_CACHE_MAX_SIZE_BYTES = "900";
    process.env.CLAUDE_OPENCODE_REASONING_CACHE_MAX_AGE_MS = "0";
    delete require.cache[serverPath];
    const limitedBridge = require("../server.js");

    limitedBridge.setToolReasoning("large_1", "x".repeat(700));
    limitedBridge.setToolReasoning("large_2", "y".repeat(700));
    assert.equal(limitedBridge.saveReasoningCacheNow(), true);

    const data = fs.readFileSync(sizeCachePath, "utf8");
    assert.ok(Buffer.byteLength(data, "utf8") <= 900);
  } finally {
    fs.rmSync(sizeCachePath, { force: true });
    fs.rmSync(`${sizeCachePath}.tmp`, { force: true });
    delete require.cache[serverPath];
    if (originalCachePath === undefined) {
      process.env.CLAUDE_OPENCODE_REASONING_CACHE = cachePath;
    } else {
      process.env.CLAUDE_OPENCODE_REASONING_CACHE = originalCachePath;
    }
    if (originalMaxSize === undefined) {
      delete process.env.CLAUDE_OPENCODE_REASONING_CACHE_MAX_SIZE_BYTES;
    } else {
      process.env.CLAUDE_OPENCODE_REASONING_CACHE_MAX_SIZE_BYTES = originalMaxSize;
    }
    if (originalMaxAge === undefined) {
      delete process.env.CLAUDE_OPENCODE_REASONING_CACHE_MAX_AGE_MS;
    } else {
      process.env.CLAUDE_OPENCODE_REASONING_CACHE_MAX_AGE_MS = originalMaxAge;
    }
    require("../server.js");
  }
});

test("DeepSeek tool_choice any is softened to a system instruction", () => {
  const payload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-pro[1m]",
      messages: [{ role: "user", content: "Use a tool." }],
      tool_choice: { type: "any" },
    },
    false,
  );

  assert.equal(payload.tool_choice, undefined);
  assert.match(payload.messages[0].content, /requires a tool call/);
});

test("streamOpenAiAsAnthropic marks interrupted streams", async () => {
  async function* body() {
    yield Buffer.from(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      "utf8",
    );
    throw new Error("boom");
  }

  const writes = [];
  const res = {
    destroyed: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk) {
      writes.push(String(chunk));
    },
    end() {
      this.writableEnded = true;
    },
  };

  await bridge.streamOpenAiAsAnthropic({ body: body() }, res, "deepseek-v4-pro[1m]");

  const output = writes.join("");
  assert.match(output, /partial/);
  assert.match(output, /\[stream interrupted\]/);
  assert.match(output, /event: message_stop/);
});

test("createServer returns 413 when request body is too large", async () => {
  const originalLimit = process.env.CLAUDE_OPENCODE_REQUEST_BODY_LIMIT_BYTES;
  process.env.CLAUDE_OPENCODE_REQUEST_BODY_LIMIT_BYTES = "1";

  const serverPath = require.resolve("../server.js");
  delete require.cache[serverPath];
  const limitedBridge = require("../server.js");
  const server = limitedBridge.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "unused",
      },
      body: "{}",
    });
    const body = await response.json();
    assert.equal(response.status, 413);
    assert.equal(body.error.type, "invalid_request_error");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete require.cache[serverPath];
    if (originalLimit === undefined) {
      delete process.env.CLAUDE_OPENCODE_REQUEST_BODY_LIMIT_BYTES;
    } else {
      process.env.CLAUDE_OPENCODE_REQUEST_BODY_LIMIT_BYTES = originalLimit;
    }
    require("../server.js");
  }
});

test("invalid numeric config fails with a clear error", () => {
  const originalPort = process.env.CLAUDE_OPENCODE_PROXY_PORT;
  const serverPath = require.resolve("../server.js");

  try {
    process.env.CLAUDE_OPENCODE_PROXY_PORT = "not-a-port";
    delete require.cache[serverPath];
    assert.throws(
      () => require("../server.js"),
      /Invalid numeric config listen\.port/,
    );
  } finally {
    delete require.cache[serverPath];
    if (originalPort === undefined) {
      delete process.env.CLAUDE_OPENCODE_PROXY_PORT;
    } else {
      process.env.CLAUDE_OPENCODE_PROXY_PORT = originalPort;
    }
    require("../server.js");
  }
});

test("Linux autostart service writes unquoted systemd WorkingDirectory", () => {
  const script = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "install-autostart-linux.sh"),
    "utf8",
  );

  assert.match(script, /WorkingDirectory=\$\(escape_systemd_path "\$REPO_DIR"\)/);
  assert.doesNotMatch(script, /WorkingDirectory="\$\(escape_systemd_arg "\$REPO_DIR"\)"/);
});

function runTrimHelper(configPath, ratio = "0.5") {
  const childEnv = { ...process.env };
  delete childEnv.CLAUDE_OPENCODE_REASONING_CACHE;
  delete childEnv.CLAUDE_OPENCODE_REASONING_CACHE_MAX_SIZE_BYTES;

  return spawnSync(
    process.execPath,
    [
      path.join(__dirname, "..", "scripts", "trim-reasoning-cache.js"),
      "--config",
      configPath,
      "--ratio",
      ratio,
    ],
    {
      encoding: "utf8",
      env: childEnv,
    },
  );
}

test("trim-reasoning-cache helper trims cache to half of configured max size", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cache-trim-"));
  const trimCachePath = path.join(tempDir, "cache.json");
  const trimConfigPath = path.join(tempDir, "config.json");

  try {
    fs.writeFileSync(
      trimConfigPath,
      JSON.stringify({
        reasoningCachePath: trimCachePath,
        reasoningCacheMaxSizeBytes: 2000,
      }),
      "utf8",
    );
    fs.writeFileSync(
      trimCachePath,
      JSON.stringify(
        {
          version: 2,
          updatedAt: Date.now(),
          toolCallReasoning: {
            oldest: { reasoning: "x".repeat(500), updatedAt: 1 },
            newest: { reasoning: "y".repeat(100), updatedAt: 999 },
          },
          assistantTextReasoning: {
            middle: { reasoning: "z".repeat(300), updatedAt: 500 },
          },
          toolContextReasoning: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = runTrimHelper(trimConfigPath);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.ok(output.removedEntries > 0);
    assert.ok(output.afterSizeBytes <= output.targetSizeBytes);

    const cache = JSON.parse(fs.readFileSync(trimCachePath, "utf8"));
    assert.equal(cache.toolCallReasoning.oldest, undefined);
    assert.equal(cache.toolCallReasoning.newest.reasoning, "y".repeat(100));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("trim-reasoning-cache helper succeeds when cache file is missing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cache-missing-"));
  const trimCachePath = path.join(tempDir, "missing-cache.json");
  const trimConfigPath = path.join(tempDir, "config.json");

  try {
    fs.writeFileSync(
      trimConfigPath,
      JSON.stringify({
        reasoningCachePath: trimCachePath,
        reasoningCacheMaxSizeBytes: 900,
      }),
      "utf8",
    );

    const result = runTrimHelper(trimConfigPath);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.message, "Cache file not found.");
    assert.equal(output.removedEntries, 0);
    assert.equal(fs.existsSync(trimCachePath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("trim-reasoning-cache helper leaves small caches untouched", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cache-small-"));
  const trimCachePath = path.join(tempDir, "cache.json");
  const trimConfigPath = path.join(tempDir, "config.json");

  try {
    fs.writeFileSync(
      trimConfigPath,
      JSON.stringify({
        reasoningCachePath: trimCachePath,
        reasoningCacheMaxSizeBytes: 10000,
      }),
      "utf8",
    );
    fs.writeFileSync(
      trimCachePath,
      JSON.stringify(
        {
          version: 2,
          updatedAt: 123,
          toolCallReasoning: {
            keep: { reasoning: "small", updatedAt: 1 },
          },
          assistantTextReasoning: {},
          toolContextReasoning: {},
        },
        null,
        2,
      ),
      "utf8",
    );
    const before = fs.readFileSync(trimCachePath, "utf8");

    const result = runTrimHelper(trimConfigPath, "1");

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.removedEntries, 0);
    assert.equal(fs.readFileSync(trimCachePath, "utf8"), before);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
