const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

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
      model: "deepseek-v4-pro",
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

  assert.equal(payload.model, "deepseek-v4-pro");
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

test("anthropicToOpenAi coalesces split assistant tool calls before tool results", () => {
  const payload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "Update docs." },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "Edit",
              input: { file_path: "CLAUDE.md" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_2",
              name: "Edit",
              input: { file_path: "README.md" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: "CLAUDE.md updated",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_2",
              content: "README.md updated",
            },
          ],
        },
      ],
    },
    false,
  );

  assert.deepEqual(
    payload.messages.map((message) => message.role),
    ["user", "assistant", "tool", "tool"],
  );
  assert.equal(payload.messages[1].tool_calls.length, 2);
  assert.equal(payload.messages[1].tool_calls[0].id, "call_1");
  assert.equal(payload.messages[1].tool_calls[1].id, "call_2");
  assert.equal(payload.messages[2].tool_call_id, "call_1");
  assert.equal(payload.messages[3].tool_call_id, "call_2");
});

test("anthropicToOpenAi keeps tool results before user text in a mixed user block", () => {
  const payload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "Read then continue." },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "Read",
              input: { file_path: "README.md" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Continue after this result." },
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: "README contents",
            },
          ],
        },
      ],
    },
    false,
  );

  assert.deepEqual(
    payload.messages.map((message) => message.role),
    ["user", "assistant", "tool", "user"],
  );
  assert.equal(payload.messages[2].tool_call_id, "call_1");
  assert.equal(payload.messages[3].content, "Continue after this result.");
});

test("anthropicToOpenAi preserves ordered text and base64 images for DeepSeek Vision", () => {
  const payload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-flash-vision-exp",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Before" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBORw0KGgo=",
              },
            },
            { type: "text", text: "After" },
          ],
        },
      ],
    },
    false,
  );

  assert.deepEqual(payload.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "Before" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
        },
        { type: "text", text: "After" },
      ],
    },
  ]);
});

test("anthropicToOpenAi keeps image-only URL messages for DeepSeek Vision", () => {
  const payload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-flash-vision-exp",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url: "https://example.com/screenshot.webp" },
            },
          ],
        },
      ],
    },
    true,
  );

  assert.deepEqual(payload.messages[0], {
    role: "user",
    content: [
      {
        type: "image_url",
        image_url: { url: "https://example.com/screenshot.webp" },
      },
    ],
  });
  assert.equal(payload.stream, true);
});

test("image input is rejected for non-vision, system, assistant, and file-source requests", () => {
  const base64Image = {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "/9j/2Q==" },
  };

  assert.throws(
    () =>
      bridge.anthropicToOpenAi(
        {
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: [base64Image] }],
        },
        false,
      ),
    /does not support image input.*deepseek-v4-flash-vision-exp/,
  );
  assert.throws(
    () =>
      bridge.anthropicToOpenAi(
        {
          model: "deepseek-v4-flash-vision-exp",
          system: [base64Image],
          messages: [{ role: "user", content: "hello" }],
        },
        false,
      ),
    /only accepts images in user messages, not system content/,
  );
  assert.throws(
    () =>
      bridge.anthropicToOpenAi(
        {
          model: "deepseek-v4-flash-vision-exp",
          messages: [{ role: "assistant", content: [base64Image] }],
        },
        false,
      ),
    /only accepts images in user messages, not assistant messages/,
  );
  assert.throws(
    () =>
      bridge.anthropicToOpenAi(
        {
          model: "deepseek-v4-flash-vision-exp",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "file", file_id: "file-api-example" },
                },
              ],
            },
          ],
        },
        false,
      ),
    /does not proxy DeepSeek's Files API/,
  );
});

test("vision image validation enforces media type, URL protocol, length, and count limits", () => {
  const convertImage = (image) =>
    bridge.anthropicToOpenAi(
      {
        model: "deepseek-v4-flash-vision-exp",
        messages: [{ role: "user", content: [image] }],
      },
      false,
    );

  const unpaddedPayload = convertImage({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "TQ" },
  });
  assert.equal(
    unpaddedPayload.messages[0].content[0].image_url.url,
    "data:image/png;base64,TQ==",
  );

  assert.throws(
    () =>
      convertImage({
        type: "image",
        source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" },
      }),
    /Unsupported image media_type/,
  );
  assert.throws(
    () =>
      convertImage({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "TQ$" },
      }),
    /invalid base64 data/,
  );
  assert.throws(
    () =>
      convertImage({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "A" },
      }),
    /invalid base64 data/,
  );
  assert.throws(
    () => convertImage({ type: "image" }),
    /require a source object/,
  );
  assert.throws(
    () =>
      convertImage({
        type: "image",
        source: { type: "url", url: "   " },
      }),
    /requires a non-empty url/,
  );
  assert.throws(
    () =>
      convertImage({
        type: "image",
        source: { type: "url", url: "not a URL" },
      }),
    /valid public http\(s\) URL/,
  );
  assert.throws(
    () =>
      convertImage({
        type: "image",
        source: { type: "url", url: "ftp://example.com/image.png" },
      }),
    /must use http or https/,
  );
  assert.throws(
    () =>
      convertImage({
        type: "image",
        source: { type: "url", url: `https://example.com/${"x".repeat(8192)}` },
      }),
    /8192-character limit/,
  );
  assert.throws(
    () =>
      convertImage({
        type: "image",
        source: { type: "bytes", data: "TQ==" },
      }),
    /Unsupported Anthropic image source type/,
  );

  const maximumImages = Array.from({ length: 600 }, () => ({
    type: "image",
    source: { type: "url", url: "https://example.com/image.png" },
  }));
  const maximumPayload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-flash-vision-exp",
      messages: [{ role: "user", content: maximumImages }],
    },
    false,
  );
  assert.equal(maximumPayload.messages[0].content.length, 600);

  const tooManyImages = [...maximumImages, maximumImages[0]];
  assert.throws(
    () =>
      bridge.anthropicToOpenAi(
        {
          model: "deepseek-v4-flash-vision-exp",
          messages: [{ role: "user", content: tooManyImages }],
        },
        false,
      ),
    /600 images per request/,
  );
});

test("tool_result images follow contiguous tool messages as user image content", () => {
  bridge.setToolReasoning("call_image", "reasoning for image tool call");
  const payload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-flash-vision-exp",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_image", name: "Screenshot", input: {} },
            { type: "tool_use", id: "call_text", name: "Read", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_image",
              content: [
                { type: "text", text: "screenshot captured" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "iVBORw0KGgo=",
                  },
                },
              ],
            },
            {
              type: "tool_result",
              tool_use_id: "call_text",
              content: "file contents",
            },
          ],
        },
      ],
    },
    false,
  );

  assert.deepEqual(
    payload.messages.map((message) => message.role),
    ["assistant", "tool", "tool", "user"],
  );
  assert.equal(payload.messages[0].tool_calls.length, 2);
  assert.match(payload.messages[0].reasoning_content, /reasoning for image tool call/);
  assert.match(payload.messages[1].content, /screenshot captured/);
  assert.match(payload.messages[1].content, /following user message/);
  assert.doesNotMatch(payload.messages[1].content, /iVBORw0KGgo/);
  assert.equal(payload.messages[1].tool_call_id, "call_image");
  assert.equal(payload.messages[2].content, "file contents");
  assert.equal(payload.messages[2].tool_call_id, "call_text");
  assert.deepEqual(payload.messages[3].content[1], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
  });
});

test("tool_result images merge with direct multimodal user content", () => {
  const payload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-flash-vision-exp",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_merge", name: "Screenshot", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_merge",
              content: [
                {
                  type: "image",
                  source: { type: "url", url: "https://example.com/tool.png" },
                },
              ],
            },
            { type: "text", text: "Compare the tool image with this reference." },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "TQ" },
            },
          ],
        },
      ],
    },
    false,
  );

  assert.deepEqual(
    payload.messages.map((message) => message.role),
    ["assistant", "tool", "user"],
  );
  assert.equal(payload.messages[1].tool_call_id, "call_merge");
  assert.deepEqual(payload.messages[2].content, [
    { type: "text", text: 'Image content returned by tool "call_merge":' },
    {
      type: "image_url",
      image_url: { url: "https://example.com/tool.png" },
    },
    { type: "text", text: "Compare the tool image with this reference." },
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,TQ==" },
    },
  ]);
});

test("anthropicToOpenAi drops unfulfilled tool calls from broken history", () => {
  const payload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "Update docs." },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "Edit",
              input: { file_path: "CLAUDE.md" },
            },
            {
              type: "tool_use",
              id: "call_2",
              name: "Edit",
              input: { file_path: "README.md" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_2",
              content: "README.md updated",
            },
          ],
        },
      ],
    },
    false,
  );

  assert.deepEqual(
    payload.messages.map((message) => message.role),
    ["user", "assistant", "tool"],
  );
  assert.equal(payload.messages[1].tool_calls.length, 1);
  assert.equal(payload.messages[1].tool_calls[0].id, "call_2");
  assert.equal(payload.messages[2].tool_call_id, "call_2");
});

test("anthropicToOpenAi removes assistant tool calls when all results are missing", () => {
  const payload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "Read a file." },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect it." },
            {
              type: "tool_use",
              id: "call_1",
              name: "Read",
              input: { file_path: "README.md" },
            },
          ],
        },
        { role: "user", content: "The result was lost, continue anyway." },
      ],
    },
    false,
  );

  assert.deepEqual(
    payload.messages.map((message) => message.role),
    ["user", "assistant", "user"],
  );
  assert.equal(payload.messages[1].tool_calls, undefined);
  assert.equal(payload.messages[1].content, "I will inspect it.");
});

test("anthropicToOpenAi converts orphan tool results into user text", () => {
  const payload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-pro",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_missing",
              content: "orphan result",
            },
          ],
        },
      ],
    },
    false,
  );

  assert.deepEqual(
    payload.messages.map((message) => message.role),
    ["user"],
  );
  assert.match(payload.messages[0].content, /Tool result without a matching tool call/);
  assert.match(payload.messages[0].content, /orphan result/);
});

test("openAiToAnthropic converts text and tool calls", () => {
  const message = bridge.openAiToAnthropic(
    {
      id: "chatcmpl_1",
      model: "deepseek-v4-pro",
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
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_cache_hit_tokens: 4,
        prompt_cache_miss_tokens: 6,
      },
    },
    "deepseek-v4-pro",
  );

  assert.equal(message.id, "chatcmpl_1");
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.usage, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 4,
    cache_creation_input_tokens: 6,
  });
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

test("currentToolContextParts resets stale tool context on an image-only user turn", () => {
  assert.deepEqual(
    bridge.currentToolContextParts([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_stale", name: "Screenshot", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", url: "https://example.com/new-turn.png" },
          },
        ],
      },
    ]),
    [],
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
      'data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"prompt_cache_hit_tokens":1,"prompt_cache_miss_tokens":2}}\n\n',
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

  await bridge.streamOpenAiAsAnthropic({ body: body() }, res, "deepseek-v4-pro");

  const output = writes.join("");
  assert.equal(res.status, 200);
  assert.match(output, /"type":"thinking"/);
  assert.match(output, /"type":"thinking_delta"/);
  assert.match(output, /"thinking":"thinking\.\.\."/);
  assert.match(output, /event: content_block_delta/);
  assert.match(output, /"text":"OK"/);
  assert.match(output, /event: message_delta/);
  assert.match(output, /"input_tokens":3/);
  assert.match(output, /"output_tokens":2/);
  assert.match(output, /"cache_read_input_tokens":1/);
  assert.match(output, /"cache_creation_input_tokens":2/);
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

test("createServer exposes and forwards DeepSeek Vision image payloads", async () => {
  const originalFetch = global.fetch;
  let upstreamCalls = 0;
  let upstreamUrl;
  let upstreamPayload;
  let upstreamAuthorization;
  global.fetch = async (url, options) => {
    upstreamCalls += 1;
    upstreamUrl = String(url);
    upstreamPayload = JSON.parse(options.body);
    upstreamAuthorization = options.headers.authorization;
    return new Response(
      JSON.stringify({
        id: "chatcmpl_vision",
        model: "deepseek-v4-flash-vision-exp",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "vision ok" },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const server = bridge.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const modelsResponse = await originalFetch(`http://127.0.0.1:${port}/v1/models`);
    const modelsBody = await modelsResponse.json();
    assert.equal(
      modelsBody.data.some((model) => model.id === "deepseek-v4-flash-vision-exp"),
      true,
    );

    const response = await originalFetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-opencode-key",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash-vision-exp",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/webp",
                  data: "UklGRg==",
                },
              },
            ],
          },
        ],
      }),
    });
    const responseBody = await response.json();

    assert.equal(response.status, 200);
    assert.equal(responseBody.content[0].text, "vision ok");
    assert.equal(upstreamCalls, 1);
    assert.equal(upstreamUrl, "https://opencode.ai/zen/go/v1/chat/completions");
    assert.equal(upstreamAuthorization, "Bearer test-opencode-key");
    assert.deepEqual(upstreamPayload.messages[0].content[1], {
      type: "image_url",
      image_url: { url: "data:image/webp;base64,UklGRg==" },
    });

    const rejected = await originalFetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-opencode-key",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "iVBORw==" },
              },
            ],
          },
        ],
      }),
    });
    const rejectedBody = await rejected.json();
    assert.equal(rejected.status, 400);
    assert.match(rejectedBody.error.message, /does not support image input/);
    assert.equal(upstreamCalls, 1, "invalid image requests must not reach the upstream");

    const malformedToolImage = await originalFetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-opencode-key",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash-vision-exp",
        max_tokens: 64,
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_bad_image", name: "Screenshot", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_bad_image",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: 123 },
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    const malformedToolImageBody = await malformedToolImage.json();
    assert.equal(malformedToolImage.status, 400);
    assert.match(malformedToolImageBody.error.message, /invalid base64 data/);
    assert.equal(upstreamCalls, 1, "malformed tool images must not reach the upstream");
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("tool_choice auto is passed through while DeepSeek forced tool choice is softened", () => {
  const autoPayload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-pro",
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
      model: "deepseek-v4-pro",
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
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "think" }],
      output_config: { effort: "xhigh" },
    },
    false,
  );

  assert.equal(highPayload.reasoning_effort, "high");

  const adaptiveLowPayload = bridge.anthropicToOpenAi(
    {
      model: "deepseek-v4-flash-vision-exp",
      messages: [{ role: "user", content: "inspect carefully" }],
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    },
    false,
  );

  assert.deepEqual(adaptiveLowPayload.thinking, { type: "enabled" });
  assert.equal(adaptiveLowPayload.reasoning_effort, "low");
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
      model: "deepseek-v4-pro",
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
      model: "deepseek-v4-pro",
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
      model: "deepseek-v4-pro",
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

  await bridge.streamOpenAiAsAnthropic({ body: body() }, res, "deepseek-v4-pro");

  const output = writes.join("");
  assert.match(output, /partial/);
  assert.match(output, /\[stream interrupted\]/);
  assert.match(output, /event: message_stop/);
});

test("createServer returns 413 when request body is too large", async () => {
  const originalLimit = process.env.CLAUDE_OPENCODE_REQUEST_BODY_LIMIT_BYTES;
  process.env.CLAUDE_OPENCODE_REQUEST_BODY_LIMIT_BYTES = "4";

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
      body: JSON.stringify("界"),
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

test("Linux autostart service captures proxy environment for Node fetch", () => {
  const script = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "install-autostart-linux.sh"),
    "utf8",
  );

  assert.match(script, /proxy_environment_lines\(\)/);
  assert.match(script, /HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy/);
  assert.match(script, /Environment="%s=%s"\\n/);
  assert.match(script, /--use-env-proxy/);
  assert.match(script, /ExecStart="\$\(escape_systemd_arg "\$NODE_BIN"\)"\$NODE_ENV_PROXY_ARG/);
});

test("Linux autostart service warns when lingering is not enabled", () => {
  const script = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "install-autostart-linux.sh"),
    "utf8",
  );

  assert.match(script, /loginctl show-user "\$USER" -p Linger --value/);
  assert.match(script, /sudo loginctl enable-linger/);
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

function routingUpstreamStub(calls) {
  return async (url, options) => {
    const headers = new Headers(options.headers);
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push({ headers: Object.fromEntries(headers), payload, method: options.method, url: String(url) });
    if (!headers.get("x-opencode-session") && !headers.get("x-claude-code-session-id")) {
      return new Response(JSON.stringify({ error: { message: "MissingSessionID" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (!payload) {
      return new Response(JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (payload.stream) {
      return new Response(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "routing ok" }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response(JSON.stringify({
      id: "chatcmpl_routing",
      model: payload.model,
      choices: [{ message: { role: "assistant", content: "routing ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }), { headers: { "content-type": "application/json" } });
  };
}

test("both completion routes preserve supported sessions and reject missing sessions", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = routingUpstreamStub(calls);
  const server = bridge.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const opencodeHeaders = {
    "x-opencode-session": "session-opencode",
    "x-opencode-project": "project-test",
    "x-opencode-client": "client-test",
    "x-opencode-request": "request-test",
  };
  const claudeHeaders = { "x-claude-code-session-id": "session-claude" };
  const cases = [
    { name: "OpenCode session", headers: opencodeHeaders, status: 200 },
    { name: "Claude Code session", headers: claudeHeaders, status: 200 },
    { name: "both sessions", headers: { ...opencodeHeaders, ...claudeHeaders }, status: 200 },
    { name: "missing session", headers: { "x-opencode-project": "project-test" }, status: 400 },
  ];

  try {
    for (const endpoint of ["/v1/messages", "/v1/chat/completions"]) {
      for (const stream of [false, true]) {
        for (const routing of cases) {
          const label = `${endpoint}, stream=${stream}, ${routing.name}`;
          const response = await originalFetch(`http://127.0.0.1:${port}${endpoint}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer test-bearer-key",
              "x-api-key": "ignored-api-key",
              "user-agent": "claude-code/test",
              cookie: "private-cookie=test",
              "x-opencode-secret": "private-routing-value",
              "anthropic-version": "2023-06-01",
              ...routing.headers,
            },
            body: JSON.stringify({
              model: "deepseek-v4-flash",
              max_tokens: 64,
              stream,
              messages: [{ role: "user", content: "hi" }],
            }),
          });
          const body = await response.text();
          assert.equal(response.status, routing.status, label);
          assert.deepEqual(calls.at(-1).headers, {
            authorization: "Bearer test-bearer-key",
            "content-type": "application/json",
            "user-agent": "claude-code/test",
            ...routing.headers,
          }, label);
          assert.equal(calls.at(-1).payload.stream, stream, label);
          if (routing.status === 400) {
            assert.match(body, /MissingSessionID/, label);
          } else if (stream) {
            assert.match(response.headers.get("content-type"), /text\/event-stream/, label);
            assert.match(body, /routing ok/, label);
            assert.match(body, endpoint === "/v1/messages" ? /message_stop/ : /\[DONE\]/, label);
          } else {
            const result = JSON.parse(body);
            assert.equal(
              endpoint === "/v1/messages" ? result.content[0].text : result.choices[0].message.content,
              "routing ok",
              label,
            );
          }
        }
      }
    }
    assert.equal(calls.length, 16);
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("completion requests without a user agent use the bridge version", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = routingUpstreamStub(calls);
  const server = bridge.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const response = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: "127.0.0.1",
        port: server.address().port,
        path: "/v1/messages",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-opencode-key",
          "x-claude-code-session-id": "session-no-user-agent",
        },
      }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
        res.on("error", reject);
      });
      request.on("error", reject);
      request.end(JSON.stringify({
        model: "deepseek-v4-flash",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }));
    });
    assert.equal(response.status, 200, response.body);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.authorization, "Bearer test-opencode-key");
    assert.equal(
      calls[0].headers["user-agent"],
      `deepseek-v4-opencode-claude-code-bridge/${require("../package.json").version}`,
    );
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("upstream health probes preserve the same caller routing headers", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = routingUpstreamStub(calls);
  const server = bridge.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const routingHeaders = {
    "x-opencode-session": "session-probe",
    "x-opencode-project": "project-probe",
    "x-opencode-client": "client-probe",
    "x-opencode-request": "request-probe",
    "x-claude-code-session-id": "claude-session-probe",
    "user-agent": "claude-code/probe-test",
  };

  try {
    const response = await originalFetch(`http://127.0.0.1:${server.address().port}/health?probe=upstream`, {
      headers: { "x-api-key": "test-probe-key", cookie: "private=test", ...routingHeaders },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).upstream_probe, { ok: true, status: 200 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].url.endsWith("/v1/models"), true);
    assert.equal(calls[0].headers.authorization, "Bearer test-probe-key");
    for (const [name, value] of Object.entries(routingHeaders)) {
      assert.equal(calls[0].headers[name], value, name);
    }
    assert.equal(calls[0].headers["x-api-key"], undefined);
    assert.equal(calls[0].headers.cookie, undefined);
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("missing config uses the current model catalog and vision defaults", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-model-defaults-"));
  try {
    const result = spawnSync(process.execPath, ["-e", `
      process.env.CLAUDE_OPENCODE_PROXY_CONFIG = process.argv[2];
      console.log = () => {};
      const bridge = require(process.argv[1]);
      (async () => {
        const server = bridge.createServer();
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
          const response = await fetch('http://127.0.0.1:' + server.address().port + '/v1/models');
          const models = (await response.json()).data.map(model => model.id);
          process.stdout.write(JSON.stringify({
            models, vision: Object.fromEntries(models.map(model => [model, bridge.isVisionModel(model)])),
          }));
        } finally {
          await new Promise(resolve => server.close(resolve));
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `, path.join(__dirname, "..", "server.js"), path.join(tempDir, "missing-config.json")], {
      encoding: "utf8",
      env: { ...process.env },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const defaults = JSON.parse(result.stdout);
    assert.deepEqual(defaults.models, [
      "deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-flash",
      "deepseek-v4-flash", "deepseek-v4-flash-vision-exp",
    ]);
    assert.deepEqual(defaults.vision, {
      "deepseek-v4.1-flash": true,
      "deepseek-v4-pro": false,
      "deepseek-flash": true,
      "deepseek-v4-flash": false,
      "deepseek-v4-flash-vision-exp": true,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("current Flash and its alias accept images while legacy Flash and Pro reject them", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
  };
  const convert = (model) => bridge.anthropicToOpenAi({
    model, messages: [{ role: "user", content: [image] }],
  }, false);
  for (const model of ["deepseek-v4.1-flash", "deepseek-flash", "deepseek-v4-flash-vision-exp"]) {
    assert.equal(bridge.isVisionModel(model), true, model);
    const payload = convert(model);
    assert.equal(payload.model, model);
    assert.deepEqual(payload.messages[0].content, [{
      type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
    }], model);
  }
  for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
    assert.equal(bridge.isVisionModel(model), false, model);
    assert.throws(() => convert(model), /does not support image input/, model);
  }
});

test("current DeepSeek effort supports minimal, ultra, and none", () => {
  for (const [effort, expected] of [["minimal", "low"], ["ultra", "max"], ["none", "none"]]) {
    const payload = bridge.anthropicToOpenAi({
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "Choose the requested effort." }],
      output_config: { effort },
    }, false);
    assert.equal(payload.reasoning_effort, expected, effort);
    assert.equal(payload.thinking, undefined, "effort does not add a separate thinking setting");
  }
  const disabled = bridge.anthropicToOpenAi({
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: "Answer without reasoning." }],
    output_config: { effort: "none" },
    thinking: { type: "disabled" },
  }, false);
  assert.equal(disabled.reasoning_effort, "none");
  assert.deepEqual(disabled.thinking, { type: "disabled" });
});

test("DeepSeek tools replay reasoning for all assistant history, including text-only turns", () => {
  const cachedHistory = [
    { text: "Cached string answer for all-history replay.", reasoning: "cached string reasoning" },
    { text: "Cached array answer for all-history replay.", reasoning: "cached array reasoning" },
  ];
  for (const cached of cachedHistory) {
    bridge.openAiToAnthropic({ choices: [{ message: {
      content: cached.text, reasoning_content: cached.reasoning,
    } }] }, "deepseek-v4.1-flash");
  }
  const assistantHistory = [
    { content: "Uncached string answer for all-history replay." },
    { content: [{ type: "text", text: "Uncached array answer for all-history replay." }] },
    { content: [
      { type: "thinking", thinking: "explicit historical reasoning" },
      { type: "text", text: "Answer with preserved thinking." },
    ], expected: "explicit historical reasoning" },
    { content: cachedHistory[0].text, excluded: cachedHistory[0].reasoning },
    { content: [{ type: "text", text: cachedHistory[1].text }], excluded: cachedHistory[1].reasoning },
  ];
  const messages = assistantHistory.flatMap((history, index) => [
    { role: "user", content: `Previous independent user turn ${index}.` },
    { role: "assistant", content: history.content },
  ]);
  messages.push({ role: "user", content: "Now use the available tool." });
  const payload = bridge.anthropicToOpenAi({
    model: "deepseek-v4.1-flash", messages,
    tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }],
  }, false);
  const assistants = payload.messages.filter((message) => message.role === "assistant");
  assert.equal(assistants.length, assistantHistory.length);
  for (const [index, assistant] of assistants.entries()) {
    assert.equal(assistant.tool_calls, undefined, "historical turns did not call tools");
    assert.equal(typeof assistant.reasoning_content, "string");
    assert.ok(assistant.reasoning_content.length > 0, "every assistant needs replayable reasoning");
    if (assistantHistory[index].expected) {
      assert.equal(assistant.reasoning_content, assistantHistory[index].expected);
    }
    if (assistantHistory[index].excluded) {
      assert.notEqual(assistant.reasoning_content, assistantHistory[index].excluded,
        "unscoped ordinary history must not reuse the global text cache");
    }
  }
});

test("reasoning replay does not add placeholders without supported DeepSeek tools", () => {
  const messages = [
    { role: "user", content: "Earlier ordinary user turn." },
    { role: "assistant", content: "Uncached ordinary string answer." },
    { role: "user", content: "Another ordinary user turn." },
    { role: "assistant", content: [{ type: "text", text: "Uncached ordinary array answer." }] },
    { role: "user", content: "Continue normally." },
  ];
  const requests = [
    { model: "deepseek-v4.1-flash" },
    { model: "deepseek-v4.1-flash", tools: [] },
    { model: "deepseek-v4.1-flash", tools: [{}] },
    { model: "kimi-k2.6", tools: [{ name: "Read", input_schema: { type: "object" } }] },
  ];
  for (const request of requests) {
    const payload = bridge.anthropicToOpenAi({ ...request, messages }, false);
    for (const assistant of payload.messages.filter((message) => message.role === "assistant")) {
      assert.equal(assistant.reasoning_content, undefined, JSON.stringify(request));
    }
  }
});

test("ordinary reasoning replay is isolated by session, model, and full history", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  const sessionHeaders = {
    a: { "x-claude-code-session-id": "reasoning-session-a" },
    b: { "x-opencode-session": "reasoning-session-b" },
    c: { "x-claude-code-session-id": "reasoning-session-c" },
  };
  global.fetch = async (url, options) => {
    const headers = new Headers(options.headers);
    const payload = JSON.parse(options.body);
    const session = headers.get("x-opencode-session") || headers.get("x-claude-code-session-id") || "anonymous";
    const prompt = payload.messages.filter((message) => message.role === "user").at(-1).content;
    const reasoning = `reasoning:${session}:${payload.model}:${prompt}`;
    calls.push({ payload, reasoning });
    const choice = { message: { role: "assistant", content: "Done.", reasoning_content: reasoning }, finish_reason: "stop" };
    if (payload.stream) {
      const chunks = [
        { choices: [{ delta: { reasoning_content: reasoning } }] },
        { choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] },
      ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
      return new Response(`${chunks}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ id: "chatcmpl_scoped", model: payload.model, choices: [choice] }), {
      headers: { "content-type": "application/json" },
    });
  };
  const server = bridge.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const user = (content) => ({ role: "user", content });
  const assistantString = { role: "assistant", content: "Done." };
  const assistantArray = { role: "assistant", content: [{ type: "text", text: "Done." }] };
  const firstTurn = user("The shared first task.");
  const secondTurn = user("A second task in the same conversation.");
  const flash = "deepseek-v4.1-flash";
  const request = async (session, model, messages, stream = false) => {
    const response = await originalFetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-scoped-key", ...sessionHeaders[session] },
      body: JSON.stringify({
        model, messages, stream, max_tokens: 64,
        tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }],
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.ok(body.includes("Done."), body);
    assert.ok(body.includes(calls.at(-1).reasoning), "the generated reasoning reached the caller");
    if (stream) assert.match(body, /message_stop/);
    return calls.at(-1);
  };
  const assistantReasoning = (call) => call.payload.messages
    .filter((message) => message.role === "assistant").map((message) => message.reasoning_content);

  try {
    const firstA = await request("a", flash, [firstTurn], true);
    const firstB = await request("b", flash, [firstTurn]);
    const glm = await request("a", "glm-5.1", [firstTurn]);
    const afterGlm = await request("a", flash, [firstTurn, assistantString, user("Continue after the GLM response.")]);
    assert.deepEqual(assistantReasoning(afterGlm), [firstA.reasoning], "GLM reasoning must not replace DeepSeek reasoning");
    const pro = await request("a", "deepseek-v4-pro", [firstTurn]);
    const secondA = await request("a", flash, [firstTurn, assistantString, secondTurn]);
    const branchTurn = user("A different branch in the same session.");
    const branchA = await request("a", flash, [branchTurn], true);
    const generatedReasons = new Set([firstA, firstB, glm, pro, secondA, branchA].map((call) => call.reasoning));
    assert.equal(generatedReasons.size, 6, "identical answer text has six distinct reasoning results");
    assert.deepEqual(assistantReasoning(secondA), [firstA.reasoning]);

    const replayCases = [
      { session: "a", model: flash, history: [firstTurn, assistantString], expected: [firstA.reasoning] },
      { session: "b", model: flash, history: [firstTurn, assistantArray], expected: [firstB.reasoning] },
      { session: "a", model: "deepseek-v4-pro", history: [firstTurn, assistantArray], expected: [pro.reasoning] },
      { session: "a", model: flash, history: [firstTurn, assistantArray, secondTurn, assistantString],
        expected: [firstA.reasoning, secondA.reasoning] },
      { session: "a", model: flash, history: [branchTurn, assistantArray], expected: [branchA.reasoning] },
    ];
    for (const replay of replayCases) {
      const call = await request(replay.session, replay.model, [...replay.history, user("Continue from this history.")]);
      assert.deepEqual(assistantReasoning(call), replay.expected, JSON.stringify(replay));
    }
    for (const [session, firstMessage] of [["c", firstTurn], ["a", user("An unseen history prefix.")], [null, firstTurn]]) {
      const unrelatedReasons = new Set(calls.map((call) => call.reasoning));
      const call = await request(session, flash, [firstMessage, assistantString, user("Continue without a matching cache.")]);
      const [reasoning] = assistantReasoning(call);
      assert.equal(typeof reasoning, "string");
      assert.ok(reasoning.length > 0);
      assert.equal(unrelatedReasons.has(reasoning), false, "unrelated histories must not borrow generated reasoning");
    }
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

async function withReasoningReplayServer(answer, run) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    const reasoning = `replay regression ${calls.length}: ${payload.model}`;
    calls.push({ payload, reasoning });
    if (payload.stream) {
      const chunks = [
        { choices: [{ delta: { reasoning_content: reasoning } }] },
        { choices: [{ delta: { content: answer }, finish_reason: "stop" }] },
      ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
      return new Response(`${chunks}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: answer, reasoning_content: reasoning }, finish_reason: "stop" }],
    }), { headers: { "content-type": "application/json" } });
  };
  const server = bridge.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const request = async (session, model, messages, stream = false) => {
    const response = await originalFetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-api-key": "test-replay-key",
        "x-claude-code-session-id": session,
      },
      body: JSON.stringify({
        model, messages, stream, max_tokens: 64,
        tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }],
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.ok(body.includes(calls.at(-1).reasoning), "reasoning reaches the caller");
    if (stream) assert.match(body, /message_stop/);
    return calls.at(-1);
  };
  try {
    await run(request);
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
}

test("tool-context reasoning stays isolated across models, sessions, and history prefixes", async () => {
  const answer = "Tool-context isolation regression answer.";
  const flash = "deepseek-v4.1-flash";
  const history = (prefix) => [
    { role: "user", content: prefix },
    { role: "assistant", content: [
      { type: "thinking", thinking: "Original tool planning." },
      { type: "tool_use", id: "tool-context-isolation-id", name: "Read", input: {} },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-context-isolation-id", content: "same result" }] },
  ];
  await withReasoningReplayServer(answer, async (request) => {
    for (const stream of [false, true]) {
      const original = history(`Original prefix, stream=${stream}.`);
      const branch = history(`Different prefix, stream=${stream}.`);
      const seeds = [
        { session: "tool-replay-a", model: flash, history: original },
        { session: "tool-replay-b", model: flash, history: original },
        { session: "tool-replay-a", model: "deepseek-v4-pro", history: original },
        { session: "tool-replay-a", model: flash, history: branch },
      ];
      for (const seed of seeds) {
        seed.expected = (await request(seed.session, seed.model, seed.history, stream)).reasoning;
      }
      await request("tool-replay-a", "glm-5.1", original, stream);
      for (const seed of seeds) {
        for (const content of [answer, [{ type: "text", text: answer }]]) {
          const call = await request(seed.session, seed.model, [
            ...seed.history, { role: "assistant", content }, { role: "user", content: "Continue." },
          ], stream);
          assert.equal(call.payload.messages.filter((message) => message.role === "assistant").at(-1).reasoning_content,
            seed.expected, `${seed.session}, ${seed.model}, stream=${stream}, ${typeof content}`);
        }
      }
      for (const [session, prefix] of [["tool-replay-unseen", original[0].content], ["tool-replay-a", "Unseen prefix."]]) {
        const call = await request(session, flash, [
          ...history(prefix), { role: "assistant", content: answer }, { role: "user", content: "Continue." },
        ], stream);
        const reasoning = call.payload.messages.filter((message) => message.role === "assistant").at(-1).reasoning_content;
        assert.ok(reasoning, "missing cache uses a nonempty compatibility value");
        assert.ok(seeds.every((seed) => seed.expected !== reasoning), "unseen histories cannot borrow tool-context reasoning");
      }
    }
  });
});

test("reasoning history ignores moved cache markers but preserves tool input business values", async () => {
  const answer = "Cache-marker normalization regression answer.";
  const model = "deepseek-v4.1-flash";
  const marker = { type: "ephemeral" };
  const text = (value, marked) => ({ type: "text", text: value, ...(marked ? { cache_control: marker } : {}) });
  const history = (marked, policy = "policy-a") => [
    { role: "user", content: marked ? [text("Read the marked history.", true)] : "Read the marked history." },
    { role: "assistant", content: [
      { type: "thinking", thinking: "Original tool planning." },
      { type: "tool_use", id: "cache-marker-tool", name: "Read", input: { cache_control: policy },
        ...(marked ? { cache_control: marker } : {}) },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "cache-marker-tool", content: [
        text("Nested tool result.", marked),
        { type: "image", source: { type: "url", url: "https://example.invalid/cache-marker.png" },
          ...(marked ? { cache_control: marker } : {}) },
      ], ...(marked ? { cache_control: marker } : {}) },
      text("Give the final answer.", marked),
    ] },
  ];
  await withReasoningReplayServer(answer, async (request) => {
    for (const stream of [false, true]) {
      const session = `cache-marker-session-${stream}`;
      const first = await request(session, model, history(true), stream);
      const secondHistory = [
        ...history(false), { role: "assistant", content: [text(answer, true)] },
        { role: "user", content: "Second turn." },
      ];
      const second = await request(session, model, secondHistory, stream);
      assert.equal(second.payload.messages.filter((message) => message.role === "assistant").at(-1).reasoning_content,
        first.reasoning, "top-level and nested cache markers do not alter the first response scope");
      for (const content of [answer, [text(answer, true)], [{ cache_control: marker, text: answer, type: "text" }]]) {
        const continued = await request(session, model, [
          ...history(true), { role: "assistant", content: answer },
          { role: "user", content: [text("Second turn.", true)] },
          { role: "assistant", content }, { role: "user", content: "Continue." },
        ], stream);
        const reasoning = continued.payload.messages.filter((message) => message.role === "assistant").at(-1).reasoning_content;
        assert.equal(reasoning, second.reasoning, "assistant markers and string/single-text blocks are equivalent");
      }
      const changedInput = await request(session, model, [
        ...history(false, "policy-b"), { role: "assistant", content: answer },
        { role: "user", content: "Continue with a different business policy." },
      ], stream);
      assert.notEqual(changedInput.payload.messages.filter((message) => message.role === "assistant").at(-1).reasoning_content,
        first.reasoning, "tool input cache_control is business data and must remain part of the history scope");
    }
  });
});

test("tool-context bucket retains scoped entries and legacy unscoped compatibility", async () => {
  const serverPath = path.join(__dirname, "..", "server.js");
  const module = { exports: {} };
  vm.runInNewContext(`${fs.readFileSync(serverPath, "utf8")}\nmodule.exports = {
    getToolContextReasoning, setToolContextReasoning, openAiToAnthropic, streamOpenAiAsAnthropic,
  };`, {
    require: createRequire(serverPath), module, process, console, Buffer, TextDecoder,
    __dirname: path.dirname(serverPath), __filename: serverPath,
    setTimeout: () => 1, clearTimeout: () => {},
  }, { filename: serverPath });
  const { getToolContextReasoning, setToolContextReasoning, openAiToAnthropic, streamOpenAiAsAnthropic } = module.exports;
  const parts = ["tool_use:isolated-bucket:Read:{}", "tool_result:isolated-bucket:same result"];
  const answer = "Same bucket answer.";
  setToolContextReasoning(parts, answer, "legacy reasoning");
  assert.equal(getToolContextReasoning(parts, answer), "legacy reasoning");
  assert.equal(getToolContextReasoning(parts, answer, "scope-a"), null, "scoped reads cannot fall back to legacy entries");
  setToolContextReasoning(parts, answer, "scope-a reasoning", "scope-a");
  setToolContextReasoning(parts, answer, "scope-b reasoning", "scope-b");
  assert.equal(getToolContextReasoning(parts, answer, "scope-a"), "scope-a reasoning");
  assert.equal(getToolContextReasoning(parts, answer, "scope-b"), "scope-b reasoning");
  assert.equal(getToolContextReasoning(parts, answer, "scope-c"), null);
  assert.equal(getToolContextReasoning(parts, answer), "legacy reasoning", "scoped writes preserve legacy entries");
  openAiToAnthropic({ choices: [{ message: {
    content: answer, reasoning_content: "nonstream scoped reasoning",
  } }] }, "deepseek-v4.1-flash", parts, "nonstream-scope");
  assert.equal(getToolContextReasoning(parts, answer, "nonstream-scope"), "nonstream scoped reasoning");
  const res = { writeHead() {}, write() {}, end() {} };
  await streamOpenAiAsAnthropic({ body: (async function* () {
    yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: {
      content: answer, reasoning_content: "stream scoped reasoning",
    }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  })() }, res, "deepseek-v4.1-flash", parts, null, "stream-scope");
  assert.equal(getToolContextReasoning(parts, answer, "stream-scope"), "stream scoped reasoning");
  assert.equal(getToolContextReasoning(parts, answer), "legacy reasoning", "both response paths preserve legacy entries");
});
