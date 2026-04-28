# DeepSeek V4 OpenCode Claude Code Bridge

Languages: [English](README.md) | [简体中文](README.zh-CN.md)

DeepSeek V4 OpenCode Claude Code Bridge is a local compatibility bridge for using
OpenCode Go's DeepSeek V4 series as a Claude Code backend.

Claude Code sends Anthropic `/v1/messages` requests. OpenCode Go exposes
DeepSeek V4 through OpenAI-compatible `/v1/chat/completions`. This proxy
translates between the two protocols and preserves the DeepSeek V4
`reasoning_content` history required for thinking-mode tool calls.

Other OpenCode Go models that use `/v1/chat/completions` may also work, but
they are best-effort/experimental because their tool-calling behavior can differ
from DeepSeek V4.

## What It Does

Request path:

```text
Claude Code
  -> local proxy /v1/messages
  -> OpenCode Go /v1/chat/completions
  -> an OpenAI-compatible model
```

The proxy translates:

```text
Anthropic Messages API
messages[].content text/tool_use/tool_result
tools[{ name, description, input_schema }]
tool_choice
SSE message_* and content_block_* events
```

into:

```text
OpenAI-compatible Chat Completions
messages role=user/assistant/tool
tools[{ type: "function", function: { name, description, parameters } }]
tool_calls
streaming chat completion chunks
```

For DeepSeek V4, it also preserves `reasoning_content` for thinking-mode tool
calls. DeepSeek requires that reasoning content be sent back in later tool-call
history. The proxy stores it in a local cache so continued Claude Code sessions
do not fail with `reasoning_content must be passed back`.

## Current Scope

Supported:

- Claude Code `/v1/messages` non-streaming and streaming requests.
- Text content.
- Claude Code tool calls and tool results.
- OpenAI-compatible function calling.
- DeepSeek V4 `reasoning_content` replay for tool-call history.
- Verified target: OpenCode Go DeepSeek V4 Pro and Flash.
- Experimental target: other OpenCode Go `/v1/chat/completions` models, subject
  to each model/provider's function-calling support.
- Windows, Linux, and macOS with Node.js.

Not a full Anthropic API implementation:

- Image, audio, prompt caching, and every Anthropic beta field are not targeted.
- `tool_choice` forced modes are converted to system instructions because some
  OpenCode Go upstream models reject forced `tool_choice` values.
- DeepSeek `reasoning_content` replay is enabled by default only for DeepSeek
  model names. Other models receive standard OpenAI-style chat messages.
- Thinking blocks emitted by the bridge use empty `signature` values. Claude
  Code accepts these on the local proxy path, but they are not Anthropic-signed
  thinking blocks.
- This is a compatibility bridge, not a replacement for a native Anthropic
  endpoint.

## Requirements

- Node.js 18 or newer.
- An OpenCode Go API key.
- Claude Code.

No npm dependencies are required.

## Configuration

The repository includes a ready-to-use `config.json`. It does not contain any
API key. Edit it only if you need a different port, upstream URL, model list, or
reasoning cache path.

Default config:

```json
{
  "listen": {
    "host": "127.0.0.1",
    "port": 8787
  },
  "upstream": {
    "baseUrl": "https://opencode.ai/zen/go/v1"
  },
  "models": [
    "deepseek-v4-pro[1m]",
    "deepseek-v4-flash"
  ],
  "reasoningContent": "auto",
  "reasoningCacheMaxEntries": 0,
  "reasoningCacheMaxAgeMs": 2592000000,
  "reasoningCacheMaxSizeBytes": 209715200,
  "reasoningCachePath": "~/.claude/deepseek-v4-opencode-claude-code-bridge-reasoning-cache.json",
  "requestBodyLimitBytes": 104857600,
  "upstreamTimeoutMs": 600000
}
```

Fields:

- `listen.host`: local address to bind. Keep `127.0.0.1` unless you really want
  LAN access.
- `listen.port`: local proxy port.
- `upstream.baseUrl`: OpenAI-compatible upstream base URL. For OpenCode Go,
  use `https://opencode.ai/zen/go/v1`.
- `models`: model IDs returned by the local `/v1/models` endpoint. Include the
  OpenAI-compatible upstream models you want Claude Code to see.
- `reasoningContent`: `auto`, `always`, or `never`. Keep `auto` for OpenCode Go.
  It replays DeepSeek reasoning history only for DeepSeek model names.
- `reasoningCacheMaxEntries`: maximum entries to keep in each reasoning cache
  bucket. The default `0` disables count-based trimming.
- `reasoningCacheMaxAgeMs`: maximum age for a cache entry since its last use.
  The default is 30 days. Set `0` to disable age-based trimming.
- `reasoningCacheMaxSizeBytes`: maximum serialized cache file size. The default
  is 200 MB. When the cache exceeds this size, the oldest entries are removed.
- `reasoningCachePath`: local DeepSeek reasoning cache path.
- `requestBodyLimitBytes`: maximum accepted request body size. The default is
  100 MB.
- `upstreamTimeoutMs`: maximum time to wait for an upstream OpenCode Go request
  before aborting it. The default is 10 minutes.

The default model uses the `deepseek-v4-pro[1m]` 1M-context variant. If your
OpenCode Go plan does not include that variant, replace every
`deepseek-v4-pro[1m]` value in `config.json` and Claude Code settings with
`deepseek-v4-pro`.

## Start

Start the local bridge.

Windows PowerShell:

```powershell
npm start
```

Windows cmd:

```cmd
start.cmd
```

Linux/macOS:

```bash
chmod +x ./start.sh
./start.sh
```

By default, the bridge receives the OpenCode Go key from Claude Code's
`ANTHROPIC_API_KEY` request header. Keep the OpenCode Go key in Claude Code
settings, not in `config.json`.

You can also pass a config path explicitly:

```bash
node server.js --config ./config.json
```

or:

```bash
CLAUDE_OPENCODE_PROXY_CONFIG=./config.json node server.js
```

## Claude Code Settings

Create a Claude Code settings file, for example
`~/.claude/settings.opencode-proxy.json`.

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_API_KEY": "sk-opencode-go-key",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "ANTHROPIC_MODEL": "deepseek-v4-pro[1m]",
    "ANTHROPIC_SMALL_FAST_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
    "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-v4-pro[1m]",
    "CLAUDE_CODE_EFFORT_LEVEL": "max"
  }
}
```

The example above follows the DeepSeek-style setup and sets the main model with
`ANTHROPIC_MODEL`. If you keep `ANTHROPIC_MODEL`, switching models in Claude
Code is only a per-conversation choice; new conversations will still fall back
to the model named by `ANTHROPIC_MODEL`. If you want Claude Code's model
switcher to control the default model mapping, remove `ANTHROPIC_MODEL` and
choose the model from Claude Code's UI or `/model` command. Claude Code will
maintain its own `model` field. Then `sonnet` and `opus` map to
`deepseek-v4-pro[1m]`, while `haiku` and small/fast calls map to
`deepseek-v4-flash`.

You can either keep this as a separate settings file and pass it with
`--settings`, or replace Claude Code's default `~/.claude/settings.json` with
the same content. Replacing the default settings is often simpler because it
avoids merging with older `ANTHROPIC_AUTH_TOKEN` or direct-provider settings.

Run Claude Code with:

Windows PowerShell:

```powershell
claude --settings "$HOME\.claude\settings.opencode-proxy.json"
```

Linux/macOS:

```bash
claude --settings ~/.claude/settings.opencode-proxy.json
```

For a quick test:

Windows PowerShell:

```powershell
claude -p "Reply OK only" --max-turns 1 --settings "$HOME\.claude\settings.opencode-proxy.json"
```

Linux/macOS:

```bash
claude -p "Reply OK only" --max-turns 1 --settings ~/.claude/settings.opencode-proxy.json
```

If Claude Code reports `Settings file not found` on Windows, pass the absolute
path instead of `~`, for example `C:\Users\<you>\.claude\settings.opencode-proxy.json`.

Use `ANTHROPIC_API_KEY`, not `ANTHROPIC_AUTH_TOKEN`, for the local bridge.
Claude Code sends `ANTHROPIC_API_KEY` as `x-api-key`; by default the bridge
forwards that key to OpenCode Go.

`CLAUDE_CODE_EFFORT_LEVEL=max` asks Claude Code to use the highest available
reasoning effort with the selected backend. You can lower or remove it if you
prefer faster responses. In practice, reasoning effort is not a precise control:
Claude Code session state, `/effort`, `effortLevel`, and
`CLAUDE_CODE_EFFORT_LEVEL` can interact, and DeepSeek/OpenCode Go may normalize
the final value. Treat it as a requested effort hint rather than an exact knob.

When Claude Code includes Anthropic-format `thinking` and `output_config.effort`
fields in a request, the bridge translates them to DeepSeek/OpenAI-compatible
`thinking` and `reasoning_effort` for DeepSeek model names only. The bridge does
not force thinking from `config.json`; per-session `/effort` remains owned by
Claude Code. According to DeepSeek's thinking-mode guide, thinking is enabled
by default, and complex agent requests such as Claude Code/OpenCode may be
treated as max-effort thinking requests. In practice, `/effort` and
`effortLevel` influence the effort requested from Claude Code, but they do not
guarantee exact backend behavior. If Claude Code does not send a `thinking`
field, the bridge lets DeepSeek use its own default behavior. For DeepSeek V4
compatibility, `low` and `medium` effort are sent as `high`, while `xhigh` is
sent as `max`.

When DeepSeek returns `reasoning_content`, the bridge emits Anthropic-compatible
`thinking` content blocks so Claude Code can display thinking output. The same
reasoning is also cached for later DeepSeek tool-call history replay.

To experiment with another `/v1/chat/completions` Go model, add its model ID to
`config.json`, then change the Claude Code model fields, for example:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_API_KEY": "sk-opencode-go-key",
    "ANTHROPIC_MODEL": "kimi-k2.6",
    "ANTHROPIC_SMALL_FAST_MODEL": "deepseek-v4-flash"
  }
}
```

Use the raw Go API model IDs, such as `deepseek-v4-pro[1m]` or `kimi-k2.6`, not the
OpenCode app prefix `opencode-go/<model-id>`. Non-DeepSeek models should be
considered best-effort until their function-calling behavior has been tested.

## Health Check

```bash
curl http://127.0.0.1:8787/health
```

Expected shape:

```json
{
  "ok": true,
  "listen": "http://127.0.0.1:8787",
  "upstream": "https://opencode.ai/zen/go/v1/chat/completions",
  "upstream_key_source": "request"
}
```

To verify the upstream OpenCode Go endpoint as well, pass your OpenCode Go key
and add `?probe=upstream`:

```bash
curl -H "x-api-key: sk-..." "http://127.0.0.1:8787/health?probe=upstream"
```

## Development Checks

```bash
node --check server.js
node --test
```

## Troubleshooting

- `reasoning_content must be passed back`: keep the reasoning cache file, restart
  the bridge with the same cache path, and avoid trimming old entries too
  aggressively. If the conversation history still contains old DeepSeek tool
  calls but the cache was deleted, the bridge can only send a compatibility
  placeholder for missing reasoning. That avoids a hard request failure but may
  reduce continuation quality; start a fresh Claude Code session when possible.
- Reasoning cache is trimmed unexpectedly: by default, entries unused for 30
  days expire and the serialized cache is capped at 200 MB. Increase
  `reasoningCacheMaxAgeMs` or `reasoningCacheMaxSizeBytes`, or set either value
  to `0` to disable that dimension.
- `401` or `403` from OpenCode Go: verify that Claude Code settings use
  `ANTHROPIC_API_KEY` with your OpenCode Go key. Do not use
  `ANTHROPIC_AUTH_TOKEN` for this bridge, and remove conflicting global Claude
  auth settings.
- Claude Code retries until timeout: check that the bridge is running on
  `http://127.0.0.1:8787/health`, then use
  `/health?probe=upstream` with `x-api-key` to test OpenCode Go. Increase
  `upstreamTimeoutMs` only if the upstream probe is healthy but slow.
- Thinking is not visible: make sure Claude Code is using a DeepSeek model and
  that the upstream response includes `reasoning_content`. Simple prompts may
  produce no visible thinking. Non-DeepSeek models do not receive the DeepSeek
  thinking extensions.
- `Settings file not found` on Windows: pass an absolute path such as
  `"$HOME\.claude\settings.opencode-proxy.json"` instead of `~/.claude/...`.
- Port already in use: stop the existing bridge process or change `listen.port`
  in `config.json` and update `ANTHROPIC_BASE_URL` in Claude Code settings.

## Security Notes

- Keep the proxy bound to `127.0.0.1` unless you understand the risk.
- Do not put API keys in `config.json`.
- The reasoning cache may contain model reasoning traces. Treat it as private
  session state.
- If you delete the reasoning cache, continuing old Claude Code conversations
  that used DeepSeek tool calls may fall back to a compatibility placeholder.

## Conversation Compaction

Claude Code may compact long conversations. This proxy cannot recover
DeepSeek's original `reasoning_content` from Claude Code's compacted summary,
because Claude Code does not store that DeepSeek-specific field.

The cache is designed to cover the cases that can still be recovered:

- If compaction removes old tool-call blocks and keeps only a text summary, no
  DeepSeek reasoning replay is needed for those removed blocks.
- If compaction keeps recent `tool_use` and `tool_result` blocks with their
  original tool call IDs, the proxy can replay cached reasoning for them.
- If the cache was deleted, manually trimmed, or created by a different proxy instance,
  old DeepSeek tool-call history may fall back to a compatibility placeholder.

For long-running work, keep the reasoning cache enabled and size the cache
limits for your expected session lifetime. The proxy cannot know about Claude
Code conversations that are not currently being sent to it, so entries that
expire by age, size, or count may not be recoverable later.

Cache files written by v0.2.1 and newer use schema version 2 with per-entry
timestamps. Older bridge versions can still start with that file, but they will
ignore v2 cache entries.

## Why This Exists

OpenCode Go exposes many models through `/v1/chat/completions`, including GLM,
Kimi, DeepSeek V4, MiMo, and Qwen models. Claude Code expects an
Anthropic-compatible `/v1/messages` protocol. The mismatch means these models
can be called through OpenCode Go but cannot always be used directly as full
Claude Code agent backends.

This proxy bridges that protocol mismatch:

- Anthropic tool schema becomes OpenAI function schema.
- OpenAI `tool_calls` become Anthropic `tool_use` blocks.
- Claude `tool_result` blocks become OpenAI `tool` messages.
- DeepSeek `reasoning_content` is cached and replayed when DeepSeek tool-call
  history is sent back.

The goal is practical compatibility for Claude Code plus DeepSeek V4 on OpenCode
Go, with a best-effort path for other chat-completions models. This is not a
universal gateway for every model provider.

## OpenCode Go Notes

As of the OpenCode Go documentation, these Go models use
`/v1/chat/completions` and an OpenAI-compatible or similar chat-completions
interface:

- `glm-5.1`
- `glm-5`
- `kimi-k2.6`
- `kimi-k2.5`
- `deepseek-v4-pro[1m]`
- `deepseek-v4-flash`
- `mimo-v2-pro`
- `mimo-v2-omni`
- `mimo-v2.5-pro`
- `mimo-v2.5`
- `qwen3.6-plus`
- `qwen3.5-plus`

MiniMax M2.7 and M2.5 are documented as Anthropic `/v1/messages` models, so
they usually do not need this proxy for Claude Code.

To try an experimental non-DeepSeek model, add it to `config.json`:

```json
{
  "models": [
    "deepseek-v4-pro[1m]",
    "deepseek-v4-flash",
    "kimi-k2.6"
  ],
  "reasoningContent": "auto"
}
```

## References

- [OpenCode Go documentation](https://opencode.ai/docs/zh-cn/go/) - model IDs,
  API endpoints, and AI SDK provider notes for OpenCode Go.
- [DeepSeek API documentation](https://api-docs.deepseek.com/) - official
  DeepSeek API overview.
- [DeepSeek thinking mode guide](https://api-docs.deepseek.com/guides/thinking_mode) -
  `reasoning_content` behavior and thinking-mode tool-call history requirements.
- [DeepSeek tool calls guide](https://api-docs.deepseek.com/zh-cn/guides/tool_calls) -
  DeepSeek function/tool calling behavior.
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages) -
  the `/v1/messages` protocol shape expected by Claude-compatible clients.
- [OpenAI function calling guide](https://developers.openai.com/api/docs/guides/function-calling) -
  OpenAI-style function/tool calling concepts.
- [OpenAI Chat API reference](https://developers.openai.com/api/reference/resources/chat) -
  the chat-completions-style request and response shape used by OpenAI-compatible
  upstreams.
