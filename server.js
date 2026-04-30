const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
const DEFAULT_MODELS = ["deepseek-v4-pro[1m]", "deepseek-v4-flash"];
const DEFAULT_REASONING_CACHE_PATH = path.join(
  os.homedir(),
  ".claude",
  "deepseek-v4-opencode-claude-code-bridge-reasoning-cache.json",
);
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REASONING_CACHE_MAX_ENTRIES = 0;
const DEFAULT_REASONING_CACHE_MAX_AGE_MS = 30 * DAY_MS;
const DEFAULT_REASONING_CACHE_MAX_SIZE_BYTES = 200 * 1024 * 1024;
const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 100 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const CHAT_COMPLETIONS_RESPONSE_HEADERS = ["content-type", "cache-control"];
const warnedFinishReasons = new Set();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function argValue(name) {
  const prefix = `${name}=`;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === name) return process.argv[i + 1];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

function expandHome(value) {
  if (!value || typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function resolveMaybeRelative(value, baseDir) {
  const expanded = expandHome(value);
  if (!expanded || path.isAbsolute(expanded)) return expanded;
  return path.resolve(baseDir, expanded);
}

function configValue(config, keys, fallback) {
  let cursor = config;
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object" || !(key in cursor)) return fallback;
    cursor = cursor[key];
  }
  return cursor === undefined || cursor === null ? fallback : cursor;
}

function numberConfig(name, value, fallback, options = {}) {
  const number = Number(value === undefined || value === null ? fallback : value);
  if (!Number.isFinite(number)) {
    throw new Error(`Invalid numeric config ${name}: ${JSON.stringify(value)}`);
  }
  if (options.integer && !Number.isInteger(number)) {
    throw new Error(`Invalid integer config ${name}: ${JSON.stringify(value)}`);
  }
  if (options.min !== undefined && number < options.min) {
    throw new Error(`Invalid config ${name}: ${number} is below ${options.min}`);
  }
  if (options.max !== undefined && number > options.max) {
    throw new Error(`Invalid config ${name}: ${number} is above ${options.max}`);
  }
  return number;
}

function envValue(name, fallback) {
  return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : fallback;
}

function loadConfig() {
  const defaultPath = path.join(__dirname, "config.json");
  const configPath = process.env.CLAUDE_OPENCODE_PROXY_CONFIG || argValue("--config") || defaultPath;
  const resolvedPath = path.resolve(configPath);
  const fileConfig = readJson(resolvedPath) || {};
  const configDir = path.dirname(resolvedPath);

  return {
    configPath: resolvedPath,
    listenHost:
      envValue("CLAUDE_OPENCODE_PROXY_HOST", configValue(fileConfig, ["listen", "host"], "127.0.0.1")),
    port: numberConfig(
      "listen.port",
      envValue("CLAUDE_OPENCODE_PROXY_PORT", configValue(fileConfig, ["listen", "port"], 8787)),
      8787,
      { integer: true, min: 1, max: 65535 },
    ),
    upstreamBaseUrl: normalizeBaseUrl(
      envValue(
        "CLAUDE_OPENCODE_PROXY_UPSTREAM_BASE_URL",
        configValue(fileConfig, ["upstream", "baseUrl"], DEFAULT_BASE_URL),
      ),
    ),
    reasoningCachePath: resolveMaybeRelative(
      envValue(
        "CLAUDE_OPENCODE_REASONING_CACHE",
        configValue(fileConfig, ["reasoningCachePath"], DEFAULT_REASONING_CACHE_PATH),
      ),
      configDir,
    ),
    reasoningCacheMaxEntries: numberConfig(
      "reasoningCacheMaxEntries",
      envValue(
        "CLAUDE_OPENCODE_REASONING_CACHE_MAX_ENTRIES",
        configValue(fileConfig, ["reasoningCacheMaxEntries"], DEFAULT_REASONING_CACHE_MAX_ENTRIES),
      ),
      DEFAULT_REASONING_CACHE_MAX_ENTRIES,
      { integer: true, min: 0 },
    ),
    reasoningCacheMaxAgeMs: numberConfig(
      "reasoningCacheMaxAgeMs",
      envValue(
        "CLAUDE_OPENCODE_REASONING_CACHE_MAX_AGE_MS",
        configValue(fileConfig, ["reasoningCacheMaxAgeMs"], DEFAULT_REASONING_CACHE_MAX_AGE_MS),
      ),
      DEFAULT_REASONING_CACHE_MAX_AGE_MS,
      { integer: true, min: 0 },
    ),
    reasoningCacheMaxSizeBytes: numberConfig(
      "reasoningCacheMaxSizeBytes",
      envValue(
        "CLAUDE_OPENCODE_REASONING_CACHE_MAX_SIZE_BYTES",
        configValue(fileConfig, ["reasoningCacheMaxSizeBytes"], DEFAULT_REASONING_CACHE_MAX_SIZE_BYTES),
      ),
      DEFAULT_REASONING_CACHE_MAX_SIZE_BYTES,
      { integer: true, min: 0 },
    ),
    reasoningContentMode:
      envValue("CLAUDE_OPENCODE_REASONING_CONTENT", configValue(fileConfig, ["reasoningContent"], "auto")),
    requestBodyLimitBytes: numberConfig(
      "requestBodyLimitBytes",
      envValue(
        "CLAUDE_OPENCODE_REQUEST_BODY_LIMIT_BYTES",
        configValue(fileConfig, ["requestBodyLimitBytes"], DEFAULT_REQUEST_BODY_LIMIT_BYTES),
      ),
      DEFAULT_REQUEST_BODY_LIMIT_BYTES,
      { integer: true, min: 1 },
    ),
    upstreamTimeoutMs: numberConfig(
      "upstreamTimeoutMs",
      envValue(
        "CLAUDE_OPENCODE_UPSTREAM_TIMEOUT_MS",
        configValue(fileConfig, ["upstreamTimeoutMs"], DEFAULT_UPSTREAM_TIMEOUT_MS),
      ),
      DEFAULT_UPSTREAM_TIMEOUT_MS,
      { integer: true, min: 0 },
    ),
    models: Array.isArray(fileConfig.models) && fileConfig.models.length
      ? fileConfig.models
      : DEFAULT_MODELS,
  };
}

function normalizeBaseUrl(url) {
  const base = (url || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

const CONFIG = loadConfig();
const reasoningByToolCallId = new Map();
const reasoningByAssistantText = new Map();
const reasoningByToolContext = new Map();
const PLACEHOLDER_REASONING =
  "Compatibility bridge placeholder reasoning for prior assistant history.";

function sha256(text) {
  return crypto.createHash("sha256").update(text || "", "utf8").digest("hex");
}

function cacheFileMtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return Date.now();
  }
}

function normalizeReasoningEntry(value, fallbackUpdatedAt = Date.now()) {
  if (typeof value === "string") {
    return { reasoning: value, updatedAt: fallbackUpdatedAt };
  }
  if (!value || typeof value !== "object" || typeof value.reasoning !== "string") {
    return null;
  }
  const updatedAt = Number(value.updatedAt);
  return {
    reasoning: value.reasoning,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : fallbackUpdatedAt,
  };
}

function isReasoningEntryExpired(entry, now = Date.now()) {
  const maxAgeMs = CONFIG.reasoningCacheMaxAgeMs;
  return Number.isFinite(maxAgeMs) && maxAgeMs > 0 && now - entry.updatedAt > maxAgeMs;
}

function loadReasoningCache() {
  const cache = readJson(CONFIG.reasoningCachePath);
  if (!cache || typeof cache !== "object") return;
  const fallbackUpdatedAt = Number.isFinite(Number(cache.updatedAt))
    ? Number(cache.updatedAt)
    : cacheFileMtimeMs(CONFIG.reasoningCachePath);

  for (const [id, value] of Object.entries(cache.toolCallReasoning || {})) {
    const entry = normalizeReasoningEntry(value, fallbackUpdatedAt);
    if (typeof id === "string" && entry && !isReasoningEntryExpired(entry)) {
      setMapRecent(reasoningByToolCallId, id, entry, { touch: false });
    }
  }

  for (const [hash, value] of Object.entries(cache.assistantTextReasoning || {})) {
    const entry = normalizeReasoningEntry(value, fallbackUpdatedAt);
    if (typeof hash === "string" && entry && !isReasoningEntryExpired(entry)) {
      setMapRecent(reasoningByAssistantText, hash, entry, { touch: false });
    }
  }

  for (const [hash, value] of Object.entries(cache.toolContextReasoning || {})) {
    const entry = normalizeReasoningEntry(value, fallbackUpdatedAt);
    if (typeof hash === "string" && entry && !isReasoningEntryExpired(entry)) {
      setMapRecent(reasoningByToolContext, hash, entry, { touch: false });
    }
  }

  trimReasoningCaches();
}

let saveReasoningTimer = null;
let reasoningCacheDirty = false;

function reasoningCachePayloadObject() {
  return {
    version: 2,
    note: "DeepSeek V4 reasoning_content cache for the OpenCode Go Claude Code bridge. It is required for thinking-mode tool-call history replay.",
    updatedAt: Date.now(),
    maxEntriesPerBucket: CONFIG.reasoningCacheMaxEntries,
    maxAgeMs: CONFIG.reasoningCacheMaxAgeMs,
    maxSizeBytes: CONFIG.reasoningCacheMaxSizeBytes,
    toolCallReasoning: Object.fromEntries(reasoningByToolCallId.entries()),
    assistantTextReasoning: Object.fromEntries(reasoningByAssistantText.entries()),
    toolContextReasoning: Object.fromEntries(reasoningByToolContext.entries()),
  };
}

function reasoningCachePayload() {
  trimReasoningCaches();
  return reasoningCachePayloadObject();
}

function saveReasoningCacheNow() {
  try {
    const data = JSON.stringify(reasoningCachePayload(), null, 2);
    const tmp = `${CONFIG.reasoningCachePath}.tmp`;
    fs.mkdirSync(path.dirname(CONFIG.reasoningCachePath), { recursive: true });
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, CONFIG.reasoningCachePath);
    reasoningCacheDirty = false;
    return true;
  } catch (error) {
    console.error(`Failed to save reasoning cache: ${error.message}`);
    return false;
  }
}

function flushReasoningCache() {
  if (saveReasoningTimer) {
    clearTimeout(saveReasoningTimer);
    saveReasoningTimer = null;
  }
  if (reasoningCacheDirty) saveReasoningCacheNow();
}

function scheduleSaveReasoningCache() {
  reasoningCacheDirty = true;
  if (saveReasoningTimer) return;
  saveReasoningTimer = setTimeout(() => {
    saveReasoningTimer = null;
    saveReasoningCacheNow();
  }, 100);
}

function trimMap(map) {
  const maxEntries = CONFIG.reasoningCacheMaxEntries;
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) return;
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

function trimExpiredMap(map, now) {
  for (const [key, entry] of map.entries()) {
    if (isReasoningEntryExpired(entry, now)) map.delete(key);
  }
}

function reasoningCacheSerializedSize() {
  return Buffer.byteLength(JSON.stringify(reasoningCachePayloadObject()), "utf8");
}

function deleteOldestReasoningEntry() {
  const candidates = [
    { name: "tool", map: reasoningByToolCallId },
    { name: "assistant", map: reasoningByAssistantText },
    { name: "context", map: reasoningByToolContext },
  ];
  let oldest = null;
  for (const candidate of candidates) {
    for (const [key, entry] of candidate.map.entries()) {
      if (!oldest || entry.updatedAt < oldest.entry.updatedAt) {
        oldest = { ...candidate, key, entry };
      }
    }
  }
  if (!oldest) return false;
  oldest.map.delete(oldest.key);
  return true;
}

function trimReasoningCacheSize() {
  const maxSizeBytes = CONFIG.reasoningCacheMaxSizeBytes;
  if (!Number.isFinite(maxSizeBytes) || maxSizeBytes <= 0) return;
  while (reasoningCacheSerializedSize() > maxSizeBytes) {
    if (!deleteOldestReasoningEntry()) return;
  }
}

function trimReasoningCaches() {
  const now = Date.now();
  trimExpiredMap(reasoningByToolCallId, now);
  trimExpiredMap(reasoningByAssistantText, now);
  trimExpiredMap(reasoningByToolContext, now);
  trimMap(reasoningByToolCallId);
  trimMap(reasoningByAssistantText);
  trimMap(reasoningByToolContext);
  trimReasoningCacheSize();
}

function setMapRecent(map, key, value, options = {}) {
  const entry = normalizeReasoningEntry(value);
  if (!entry) return;
  if (options.touch !== false) entry.updatedAt = Date.now();
  if (map.has(key)) map.delete(key);
  map.set(key, entry);
  trimMap(map);
}

function getMapRecent(map, key) {
  if (!map.has(key)) return null;
  const entry = map.get(key);
  if (isReasoningEntryExpired(entry)) {
    map.delete(key);
    scheduleSaveReasoningCache();
    return null;
  }
  setMapRecent(map, key, entry);
  return entry.reasoning;
}

function setToolReasoning(id, reasoning) {
  if (!id || !reasoning) return;
  setMapRecent(reasoningByToolCallId, id, reasoning);
  scheduleSaveReasoningCache();
}

function getToolReasoning(id) {
  if (!id) return null;
  return getMapRecent(reasoningByToolCallId, id);
}

function getAssistantReasoning(text) {
  return getMapRecent(reasoningByAssistantText, sha256(text));
}

function setAssistantReasoning(text, reasoning) {
  if (!text || !reasoning) return;
  setMapRecent(reasoningByAssistantText, sha256(text), reasoning);
  scheduleSaveReasoningCache();
}

function toolUseSignature(tool) {
  return `tool_use:${tool.id || ""}:${tool.name || ""}:${JSON.stringify(tool.input || {})}`;
}

function toolResultSignature(result) {
  return `tool_result:${result.tool_use_id || result.id || ""}:${stringifyToolResultContent(result.content)}`;
}

function toolContextKey(parts, assistantText) {
  if (!parts || !parts.length || !assistantText) return null;
  return sha256(`${parts.join("\n")}\nassistant:${assistantText}`);
}

function getToolContextReasoning(parts, assistantText) {
  const key = toolContextKey(parts, assistantText);
  return key ? getMapRecent(reasoningByToolContext, key) : null;
}

function setToolContextReasoning(parts, assistantText, reasoning) {
  const key = toolContextKey(parts, assistantText);
  if (!key || !reasoning) return;
  setMapRecent(reasoningByToolContext, key, reasoning);
  scheduleSaveReasoningCache();
}

function currentToolContextParts(messages) {
  let hadToolCall = false;
  let parts = [];

  for (const msg of messages || []) {
    const blocks = Array.isArray(msg && msg.content) ? msg.content : [];
    const text = typeof (msg && msg.content) === "string"
      ? msg.content
      : blocks
          .filter((block) => block && block.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("\n");
    const toolResults = blocks.filter((block) => block && block.type === "tool_result");
    const toolUses = blocks.filter((block) => block && block.type === "tool_use");

    if (msg && msg.role === "user") {
      if (!toolResults.length && text) {
        hadToolCall = false;
        parts = [];
      }
      for (const result of toolResults) {
        if (hadToolCall) parts.push(toolResultSignature(result));
      }
      continue;
    }

    if (msg && msg.role === "assistant" && toolUses.length) {
      hadToolCall = true;
      parts = toolUses.map(toolUseSignature);
    }
  }

  return hadToolCall ? parts : [];
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function sendError(res, status, message, type = "invalid_request_error") {
  sendJson(res, status, {
    type: "error",
    error: { type, message },
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let done = false;

    function cleanup() {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    }

    function fail(error) {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
      req.resume();
    }

    function onData(chunk) {
      if (done) return;
      data += chunk;
      if (data.length > CONFIG.requestBodyLimitBytes) {
        const error = new Error("Request body exceeds requestBodyLimitBytes.");
        error.status = 413;
        error.type = "invalid_request_error";
        fail(error);
      }
    }

    function onEnd() {
      if (done) return;
      done = true;
      cleanup();
      resolve(data);
    }

    function onError(error) {
      fail(error);
    }

    req.setEncoding("utf8");
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    const parseError = new Error(`Invalid JSON request body: ${error.message}`);
    parseError.status = 400;
    parseError.type = "invalid_request_error";
    throw parseError;
  }
}

function textFromAnthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function thinkingFromAnthropicContent(content) {
  if (!Array.isArray(content)) return "";
  // TODO: Anthropic redacted_thinking blocks are opaque encrypted data. DeepSeek
  // expects readable reasoning_content, so there is no safe lossless mapping yet.
  return content
    .filter((block) => block && block.type === "thinking" && typeof block.thinking === "string")
    .map((block) => block.thinking)
    .filter(Boolean)
    .join("\n");
}

function stringifyToolResultContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((block) => {
      if (!block) return "";
      if (block.type === "text") return block.text || "";
      return JSON.stringify(block);
    })
    .filter(Boolean)
    .join("\n");
}

function systemToOpenAi(system) {
  if (!system) return null;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return textFromAnthropicContent(system);
  return String(system);
}

function shouldSendReasoningContent(model) {
  const mode = String(CONFIG.reasoningContentMode || "auto").toLowerCase();
  if (["always", "true", "on"].includes(mode)) return true;
  if (["never", "false", "off", "none"].includes(mode)) return false;
  return isDeepSeekModel(model);
}

function isDeepSeekModel(model) {
  return typeof model === "string" && /(^|[-_/])deepseek/i.test(model);
}

function anthropicMessagesToOpenAi(messages, includeReasoningContent) {
  const out = [];
  let currentUserTurnHadToolCall = false;
  let currentToolContext = [];

  for (const msg of messages || []) {
    if (!msg || !msg.role) continue;

    if (typeof msg.content === "string") {
      if (msg.role === "user") currentUserTurnHadToolCall = false;
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const text = blocks
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    const thinking = thinkingFromAnthropicContent(blocks);

    const toolResults = blocks.filter((block) => block && block.type === "tool_result");
    const toolUses = blocks.filter((block) => block && block.type === "tool_use");

    if (msg.role === "user") {
      if (!toolResults.length) {
        currentUserTurnHadToolCall = false;
        currentToolContext = [];
      }
      if (text) out.push({ role: "user", content: text });
      for (const result of toolResults) {
        if (currentUserTurnHadToolCall) currentToolContext.push(toolResultSignature(result));
        out.push({
          role: "tool",
          tool_call_id: result.tool_use_id || result.id || "call_unknown",
          content: stringifyToolResultContent(result.content),
        });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const assistant = { role: "assistant", content: text || null };
      if (toolUses.length) {
        currentUserTurnHadToolCall = true;
        currentToolContext = toolUses.map(toolUseSignature);
        assistant.tool_calls = toolUses.map((tool, index) => ({
          id: tool.id || `call_${index}`,
          type: "function",
          function: {
            name: tool.name,
            arguments: JSON.stringify(tool.input || {}),
          },
        }));
        if (includeReasoningContent) {
          const reasoning = toolUses
            .map((tool) => getToolReasoning(tool.id))
            .filter(Boolean)
            .join("\n");
          assistant.reasoning_content = thinking || reasoning || PLACEHOLDER_REASONING;
        }
      } else if (text && currentUserTurnHadToolCall) {
        if (includeReasoningContent) {
          assistant.reasoning_content =
            thinking ||
            getToolContextReasoning(currentToolContext, text) ||
            getAssistantReasoning(text) ||
            PLACEHOLDER_REASONING;
        }
      }
      out.push(assistant);
      continue;
    }

    out.push({ role: msg.role, content: text });
  }

  return out;
}

function anthropicToolsToOpenAi(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools
    .filter((tool) => tool && tool.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || { type: "object", properties: {} },
      },
    }));
}

function anthropicToolChoiceToOpenAi(choice, model) {
  if (!choice || typeof choice !== "object") return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "none") return "none";
  if (isDeepSeekModel(model)) {
    // DeepSeek reasoner rejects forced function tool_choice, so any/tool are
    // converted to system instructions instead.
    return undefined;
  }
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

function toolChoiceInstruction(choice, model) {
  if (!choice || typeof choice !== "object") return null;
  if (!isDeepSeekModel(model)) return null;
  if (choice.type === "any") {
    return "The caller requires a tool call for this turn. Call one of the available tools instead of answering directly.";
  }
  if (choice.type === "tool" && choice.name) {
    return `The caller requires a tool call for this turn. Call the available tool named ${JSON.stringify(choice.name)} instead of answering directly.`;
  }
  return null;
}

function thinkingToOpenAi(thinking) {
  if (!thinking || typeof thinking !== "object") return undefined;
  if (thinking.type === "enabled" || thinking.type === "disabled") {
    return { type: thinking.type };
  }
  return undefined;
}

function reasoningEffortToOpenAi(outputConfig) {
  // Claude Code may send Anthropic-format output_config.effort. DeepSeek V4's
  // OpenAI-compatible API accepts high/max and maps low/medium to high itself;
  // we normalize here so the upstream payload is explicit and stable.
  const effort = outputConfig && typeof outputConfig === "object" ? outputConfig.effort : undefined;
  if (typeof effort !== "string") return undefined;
  const normalized = effort.toLowerCase();
  if (normalized === "max" || normalized === "xhigh") return "max";
  if (normalized === "high" || normalized === "medium" || normalized === "low") return "high";
  return undefined;
}

function anthropicToOpenAi(body, stream) {
  const messages = [];
  const sendDeepSeekExtensions = isDeepSeekModel(body.model);
  const extraSystem = toolChoiceInstruction(body.tool_choice, body.model);
  const system = [systemToOpenAi(body.system), extraSystem].filter(Boolean).join("\n\n");
  if (system) messages.push({ role: "system", content: system });
  messages.push(...anthropicMessagesToOpenAi(body.messages, shouldSendReasoningContent(body.model)));

  const payload = {
    model: body.model,
    messages,
    stream,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    tools: anthropicToolsToOpenAi(body.tools),
    tool_choice: anthropicToolChoiceToOpenAi(body.tool_choice, body.model),
    thinking: sendDeepSeekExtensions ? thinkingToOpenAi(body.thinking) : undefined,
    reasoning_effort: sendDeepSeekExtensions ? reasoningEffortToOpenAi(body.output_config) : undefined,
    stream_options: stream ? { include_usage: true } : undefined,
  };

  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === null) delete payload[key];
  }
  if (Array.isArray(payload.tools) && payload.tools.length === 0) delete payload.tools;
  return payload;
}

function parseJsonObject(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function reasoningFromMessage(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.reasoning_content === "string") return message.reasoning_content;
  if (typeof message.reasoning === "string") return message.reasoning;
  if (message.reasoning && typeof message.reasoning.content === "string") {
    return message.reasoning.content;
  }
  if (typeof message.thinking === "string") return message.thinking;
  if (message.thinking && typeof message.thinking.content === "string") {
    return message.thinking.content;
  }
  return "";
}

function thinkingContentBlock(reasoning) {
  return {
    type: "thinking",
    thinking: reasoning,
    signature: "",
  };
}

function mapFinishReason(reason) {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "stop") return "end_turn";
  if (reason && !warnedFinishReasons.has(reason)) {
    warnedFinishReasons.add(reason);
    console.warn(`Unknown upstream finish_reason: ${reason}`);
  }
  return reason || "end_turn";
}

function openAiToAnthropic(body, originalModel, toolContextParts = []) {
  const choice = body.choices && body.choices[0] ? body.choices[0] : {};
  const message = choice.message || {};
  const reasoning = reasoningFromMessage(message);
  const content = [];

  if (reasoning) {
    content.push(thinkingContentBlock(reasoning));
  }

  if (message.content) {
    if (reasoning) {
      setAssistantReasoning(message.content, reasoning);
      setToolContextReasoning(toolContextParts, message.content, reasoning);
    }
    content.push({ type: "text", text: message.content });
  }

  for (const call of message.tool_calls || []) {
    if (reasoning) {
      setToolReasoning(call.id, reasoning);
    }
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function && call.function.name,
      input: parseJsonObject(call.function && call.function.arguments),
    });
  }

  return {
    id: body.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model: body.model || originalModel,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: body.usage && (body.usage.prompt_tokens || body.usage.input_tokens) || 0,
      output_tokens: body.usage && (body.usage.completion_tokens || body.usage.output_tokens) || 0,
    },
  };
}

function makeAbortError(upstreamContext) {
  const error = new Error(upstreamContext.abortMessage);
  error.status = upstreamContext.abortStatus;
  error.type = "proxy_error";
  return error;
}

function normalizeUpstreamError(error, upstreamContext) {
  if (upstreamContext && upstreamContext.signal.aborted && !error.status) {
    return makeAbortError(upstreamContext);
  }
  return error;
}

function isLoopbackAddress(address) {
  const normalized = String(address || "").replace(/^::ffff:/, "");
  return normalized === "::1" || normalized === "localhost" || normalized.startsWith("127.");
}

function requestProcessShutdown(server) {
  setImmediate(() => {
    console.log("Received local shutdown request; flushing reasoning cache and shutting down.");
    flushReasoningCache();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

async function callOpenCode(req, payload, upstreamContext) {
  const upstreamApiKey = requestAuthToken(req);
  if (!upstreamApiKey) {
    throw new Error(
      "Upstream API key is not set. Put your OpenCode Go key in Claude Code settings as ANTHROPIC_API_KEY.",
    );
  }

  const response = await fetch(`${CONFIG.upstreamBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${upstreamApiKey}`,
      "content-type": "application/json",
    },
    signal: upstreamContext.signal,
    body: JSON.stringify(payload),
  }).catch((error) => {
    if (upstreamContext.signal.aborted) throw makeAbortError(upstreamContext);
    throw error;
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`OpenCode Go returned ${response.status}: ${text}`);
    error.status = response.status;
    throw error;
  }

  return response;
}

function sse(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeMessageStart(res, model) {
  const id = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      // Anthropic sends input_tokens in message_start, but OpenAI-compatible
      // streaming usage only arrives near the end. We report output usage in
      // message_delta and leave input_tokens at 0 to avoid buffering the stream.
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
}

function contentBlockStart(res, index, block) {
  sse(res, "content_block_start", {
    type: "content_block_start",
    index,
    content_block: block,
  });
}

function contentBlockDelta(res, index, delta) {
  sse(res, "content_block_delta", {
    type: "content_block_delta",
    index,
    delta,
  });
}

function contentBlockStop(res, index) {
  sse(res, "content_block_stop", {
    type: "content_block_stop",
    index,
  });
}

function requestAuthToken(req) {
  const authorization = req.headers.authorization || "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return req.headers["x-api-key"] || "";
}

function truncateForLog(value, maxLength = 500) {
  const text = String(value || "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function requestLabel(req) {
  return `${req.method || "?"} ${req.url || "?"}`;
}

function logRequest(req, res, startedAt) {
  const durationMs = Date.now() - startedAt;
  console.log(`${requestLabel(req)} -> ${res.statusCode} ${durationMs}ms`);
}

function logRequestError(req, status, error) {
  const message = error && error.message ? error.message : String(error);
  console.error(`${requestLabel(req)} failed with ${status}: ${message}`);
}

function upstreamResponseHeaders(headers) {
  const out = {
    "access-control-allow-origin": "*",
  };
  for (const name of CHAT_COMPLETIONS_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

function openAiUsageToAnthropic(usage) {
  if (!usage || typeof usage !== "object") return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
    output_tokens: usage.completion_tokens || usage.output_tokens || 0,
  };
}

function createUpstreamContext(res) {
  const controller = new AbortController();
  let abortStatus = 504;
  let abortMessage = `Upstream request timed out after ${CONFIG.upstreamTimeoutMs}ms`;
  let timer = null;

  function abort(message, status) {
    if (controller.signal.aborted) return;
    abortMessage = message;
    abortStatus = status;
    controller.abort();
  }

  if (CONFIG.upstreamTimeoutMs > 0) {
    timer = setTimeout(
      () => abort(`Upstream request timed out after ${CONFIG.upstreamTimeoutMs}ms`, 504),
      CONFIG.upstreamTimeoutMs,
    );
  }

  const onClose = () => {
    if (!res.writableEnded) abort("Client disconnected before upstream response completed", 499);
  };
  res.on("close", onClose);

  return {
    signal: controller.signal,
    get abortStatus() {
      return abortStatus;
    },
    get abortMessage() {
      return abortMessage;
    },
    cleanup() {
      if (timer) clearTimeout(timer);
      res.off("close", onClose);
    },
  };
}

async function probeUpstream(req) {
  const upstreamApiKey = requestAuthToken(req);
  if (!upstreamApiKey) {
    const error = new Error("OpenCode Go API key is required for upstream health probe.");
    error.status = 400;
    error.type = "invalid_request_error";
    throw error;
  }

  const controller = new AbortController();
  const timer = CONFIG.upstreamTimeoutMs > 0
    ? setTimeout(() => controller.abort(), Math.min(CONFIG.upstreamTimeoutMs, 15000))
    : null;

  try {
    const response = await fetch(`${CONFIG.upstreamBaseUrl}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${upstreamApiKey}` },
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error("Upstream health probe timed out.");
      timeoutError.status = 504;
      timeoutError.type = "proxy_error";
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function streamOpenAiAsAnthropic(upstream, res, model, toolContextParts = [], upstreamContext = null) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  writeMessageStart(res, model);

  const decoder = new TextDecoder();
  let buffer = "";
  let thinkingBlockIndex = null;
  let thinkingBlockStopped = false;
  let textBlockIndex = null;
  let nextBlockIndex = 0;
  let stopReason = "end_turn";
  const toolBlocks = new Map();
  let reasoningContent = "";
  let textContent = "";
  let usage = { input_tokens: 0, output_tokens: 0 };
  let streamInterrupted = false;

  function ensureThinkingBlock() {
    if (thinkingBlockIndex !== null) return thinkingBlockIndex;
    thinkingBlockIndex = nextBlockIndex++;
    contentBlockStart(res, thinkingBlockIndex, { type: "thinking", thinking: "", signature: "" });
    return thinkingBlockIndex;
  }

  function stopThinkingBlockIfOpen() {
    if (thinkingBlockIndex === null || thinkingBlockStopped) return;
    contentBlockDelta(res, thinkingBlockIndex, {
      type: "signature_delta",
      signature: "",
    });
    contentBlockStop(res, thinkingBlockIndex);
    thinkingBlockStopped = true;
  }

  function ensureTextBlock() {
    stopThinkingBlockIfOpen();
    if (textBlockIndex !== null) return textBlockIndex;
    textBlockIndex = nextBlockIndex++;
    contentBlockStart(res, textBlockIndex, { type: "text", text: "" });
    return textBlockIndex;
  }

  function ensureToolBlock(callIndex, chunk) {
    stopThinkingBlockIfOpen();
    if (toolBlocks.has(callIndex)) return toolBlocks.get(callIndex);
    const blockIndex = nextBlockIndex++;
    const id = chunk.id || `call_${callIndex}_${Date.now().toString(36)}`;
    const name = chunk.function && chunk.function.name || `tool_${callIndex}`;
    contentBlockStart(res, blockIndex, {
      type: "tool_use",
      id,
      name,
      input: {},
    });
    const state = { blockIndex, id, name };
    toolBlocks.set(callIndex, state);
    return state;
  }

  function handleChunk(obj) {
    const choice = obj.choices && obj.choices[0];
    if (obj.usage) usage = openAiUsageToAnthropic(obj.usage);
    if (!choice) return;
    const delta = choice.delta || {};

    if (delta.content) {
      textContent += delta.content;
      contentBlockDelta(res, ensureTextBlock(), {
        type: "text_delta",
        text: delta.content,
      });
    }

    const reasoningDelta = reasoningFromMessage(delta);
    if (reasoningDelta) {
      reasoningContent += reasoningDelta;
      // DeepSeek V4 emits reasoning before text/tool content. If another
      // upstream interleaves late reasoning after visible content starts, keep
      // caching it for replay but do not reopen a closed Anthropic thinking block.
      if (!thinkingBlockStopped) {
        contentBlockDelta(res, ensureThinkingBlock(), {
          type: "thinking_delta",
          thinking: reasoningDelta,
        });
      }
    }

    for (const call of delta.tool_calls || []) {
      const callIndex = call.index || 0;
      const state = ensureToolBlock(callIndex, call);
      const args = call.function && call.function.arguments;
      if (args) {
        contentBlockDelta(res, state.blockIndex, {
          type: "input_json_delta",
          partial_json: args,
        });
      }
    }

    if (choice.finish_reason) stopReason = mapFinishReason(choice.finish_reason);
  }

  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || "";

      for (const part of parts) {
        const dataLines = part
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (!dataLines.length) continue;
        const data = dataLines.join("\n");
        if (data === "[DONE]") continue;
        try {
          handleChunk(JSON.parse(data));
        } catch (error) {
          console.error(
            `Failed to parse upstream SSE chunk: ${error.message}; data=${truncateForLog(data)}`,
          );
        }
      }
    }
  } catch (error) {
    console.error(`Upstream stream failed: ${error.message}`);
    streamInterrupted = true;
    stopReason = "end_turn";
  } finally {
    stopThinkingBlockIfOpen();
    if (streamInterrupted) {
      contentBlockDelta(res, ensureTextBlock(), {
        type: "text_delta",
        text: "\n\n[stream interrupted]",
      });
    }
    if (textBlockIndex !== null) contentBlockStop(res, textBlockIndex);
    if (textContent && reasoningContent) {
      setAssistantReasoning(textContent, reasoningContent);
      setToolContextReasoning(toolContextParts, textContent, reasoningContent);
    }
    for (const state of toolBlocks.values()) {
      if (reasoningContent) setToolReasoning(state.id, reasoningContent);
      contentBlockStop(res, state.blockIndex);
    }

    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens || 0 },
    });
    sse(res, "message_stop", { type: "message_stop" });
    if (!res.writableEnded && !res.destroyed) res.end();
    if (upstreamContext) upstreamContext.cleanup();
  }
}

async function handleMessages(req, res) {
  const body = await readJsonBody(req);
  const wantsStream = body.stream === true;
  const toolContextParts = currentToolContextParts(body.messages);
  const payload = anthropicToOpenAi(body, wantsStream);
  const upstreamContext = createUpstreamContext(res);
  let upstream;

  try {
    upstream = await callOpenCode(req, payload, upstreamContext);

    if (wantsStream) {
      await streamOpenAiAsAnthropic(upstream, res, body.model, toolContextParts, upstreamContext);
      return;
    }

    const openAiBody = await upstream.json();
    sendJson(res, 200, openAiToAnthropic(openAiBody, body.model, toolContextParts));
  } catch (error) {
    throw normalizeUpstreamError(error, upstreamContext);
  } finally {
    upstreamContext.cleanup();
  }
}

async function handleChatCompletions(req, res) {
  const body = await readJsonBody(req);
  const upstreamContext = createUpstreamContext(res);
  let upstream;

  try {
    upstream = await callOpenCode(req, body, upstreamContext);
    res.writeHead(upstream.status, upstreamResponseHeaders(upstream.headers));
    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(chunk);
    }
    res.end();
  } catch (error) {
    throw normalizeUpstreamError(error, upstreamContext);
  } finally {
    upstreamContext.cleanup();
  }
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    res.on("finish", () => logRequest(req, res, startedAt));

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "*",
        });
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") {
        const body = {
          ok: true,
          config: CONFIG.configPath,
          listen: `http://${CONFIG.listenHost}:${CONFIG.port}`,
          upstream: `${CONFIG.upstreamBaseUrl}/chat/completions`,
          upstream_key_source: "request",
        };
        if (url.searchParams.get("probe") === "upstream") {
          body.upstream_probe = await probeUpstream(req);
        }
        sendJson(res, 200, body);
        return;
      }

      if (req.method === "POST" && url.pathname === "/shutdown") {
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
          sendError(res, 403, "Shutdown is only allowed from a local loopback client.", "forbidden_error");
          return;
        }
        sendJson(res, 200, { ok: true, shutting_down: true });
        requestProcessShutdown(server);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        sendJson(res, 200, {
          object: "list",
          data: CONFIG.models.map((id) => ({ id, object: "model", owned_by: "opencode-go" })),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        await handleMessages(req, res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await handleChatCompletions(req, res);
        return;
      }

      sendError(res, 404, `No route for ${req.method} ${url.pathname}`, "not_found_error");
    } catch (error) {
      const status = error.status && Number.isInteger(error.status) ? error.status : 500;
      const type = error.type || (status >= 500 ? "proxy_error" : "invalid_request_error");
      logRequestError(req, status, error);
      if (!res.headersSent && !res.destroyed) {
        sendError(res, status, error && error.message ? error.message : String(error), type);
      } else if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    }
  });
  return server;
}

function installShutdownHandlers(server) {
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; flushing reasoning cache and shutting down.`);
    flushReasoningCache();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("beforeExit", flushReasoningCache);
}

function startServer() {
  loadReasoningCache();
  const server = createServer();
  installShutdownHandlers(server);
  server.listen(CONFIG.port, CONFIG.listenHost, () => {
    console.log(`DeepSeek V4 OpenCode Claude Code bridge listening on http://${CONFIG.listenHost}:${CONFIG.port}`);
    console.log(`Config: ${CONFIG.configPath}`);
    console.log(`Upstream: ${CONFIG.upstreamBaseUrl}/chat/completions`);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  anthropicMessagesToOpenAi,
  anthropicToolsToOpenAi,
  anthropicToOpenAi,
  createServer,
  currentToolContextParts,
  expandHome,
  flushReasoningCache,
  getToolReasoning,
  loadReasoningCache,
  mapFinishReason,
  normalizeBaseUrl,
  openAiToAnthropic,
  reasoningFromMessage,
  requestAuthToken,
  saveReasoningCacheNow,
  setToolReasoning,
  startServer,
  streamOpenAiAsAnthropic,
  upstreamResponseHeaders,
};
