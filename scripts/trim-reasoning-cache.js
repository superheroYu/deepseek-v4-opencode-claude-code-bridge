#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_REASONING_CACHE_PATH = path.join(
  os.homedir(),
  ".claude",
  "deepseek-v4-opencode-claude-code-bridge-reasoning-cache.json",
);
const DEFAULT_REASONING_CACHE_MAX_SIZE_BYTES = 200 * 1024 * 1024;
const REASONING_BUCKETS = [
  "toolCallReasoning",
  "assistantTextReasoning",
  "toolContextReasoning",
];

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === name) return process.argv[i + 1] || fallback;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return fallback;
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function configValue(config, keys, fallback) {
  let cursor = config;
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object" || !(key in cursor)) return fallback;
    cursor = cursor[key];
  }
  return cursor === undefined || cursor === null ? fallback : cursor;
}

function envValue(name, fallback) {
  return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : fallback;
}

function numericConfig(name, value, fallback) {
  const number = Number(value === undefined || value === null ? fallback : value);
  if (!Number.isFinite(number)) {
    throw new Error(`Invalid numeric config ${name}: ${JSON.stringify(value)}`);
  }
  return number;
}

function loadTrimConfig() {
  const repoDir = path.resolve(__dirname, "..");
  const configPath = path.resolve(argValue("--config", path.join(repoDir, "config.json")));
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    fileConfig = readJson(configPath);
  }

  const configDir = path.dirname(configPath);
  const cachePath = resolveMaybeRelative(
    envValue(
      "CLAUDE_OPENCODE_REASONING_CACHE",
      configValue(fileConfig, ["reasoningCachePath"], DEFAULT_REASONING_CACHE_PATH),
    ),
    configDir,
  );
  const maxSizeBytes = numericConfig(
    "reasoningCacheMaxSizeBytes",
    envValue(
      "CLAUDE_OPENCODE_REASONING_CACHE_MAX_SIZE_BYTES",
      configValue(fileConfig, ["reasoningCacheMaxSizeBytes"], DEFAULT_REASONING_CACHE_MAX_SIZE_BYTES),
    ),
    DEFAULT_REASONING_CACHE_MAX_SIZE_BYTES,
  );
  const ratio = numericConfig("ratio", argValue("--ratio", "0.5"), 0.5);

  if (maxSizeBytes < 0) {
    throw new Error(`Invalid config reasoningCacheMaxSizeBytes: ${maxSizeBytes} is below 0`);
  }
  if (ratio <= 0 || ratio > 1) {
    throw new Error(`Invalid ratio: ${ratio}. Expected a value greater than 0 and up to 1.`);
  }

  return {
    cachePath,
    maxSizeBytes: Math.floor(maxSizeBytes),
    targetSizeBytes: Math.max(1, Math.floor(maxSizeBytes * ratio)),
  };
}

function serializedSize(value) {
  return Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
}

function entryUpdatedAt(value) {
  if (typeof value === "string") return 0;
  if (!value || typeof value !== "object") return 0;
  const updatedAt = Number(value.updatedAt);
  return Number.isFinite(updatedAt) ? updatedAt : 0;
}

function estimatedEntrySize(key, value) {
  return Buffer.byteLength(`${JSON.stringify(key)}:${JSON.stringify(value)},`, "utf8");
}

function reasoningEntriesByAge(cache) {
  const entries = [];
  for (const bucketName of REASONING_BUCKETS) {
    const bucket = cache[bucketName];
    if (!bucket || typeof bucket !== "object") continue;

    for (const [key, value] of Object.entries(bucket)) {
      entries.push({
        bucketName,
        key,
        updatedAt: entryUpdatedAt(value),
        estimatedBytes: estimatedEntrySize(key, value),
      });
    }
  }
  return entries.sort((a, b) => a.updatedAt - b.updatedAt);
}

function deleteEntry(cache, entry) {
  if (cache[entry.bucketName] && typeof cache[entry.bucketName] === "object") {
    delete cache[entry.bucketName][entry.key];
  }
}

function trimCacheToTargetSize(cache, targetSizeBytes, beforeSizeBytes) {
  if (beforeSizeBytes <= targetSizeBytes) {
    return {
      afterSizeBytes: beforeSizeBytes,
      removedEntries: 0,
    };
  }

  const entries = reasoningEntriesByAge(cache);
  let removedEntries = 0;
  let estimatedRemovedBytes = 0;
  const safetyPaddingBytes = Math.min(64 * 1024, Math.floor(targetSizeBytes * 0.01));
  const firstPassTarget = Math.max(0, beforeSizeBytes - targetSizeBytes) + safetyPaddingBytes;

  while (removedEntries < entries.length && estimatedRemovedBytes < firstPassTarget) {
    const entry = entries[removedEntries];
    deleteEntry(cache, entry);
    estimatedRemovedBytes += entry.estimatedBytes;
    removedEntries += 1;
  }

  let currentSizeBytes = serializedSize(cache);
  while (currentSizeBytes > targetSizeBytes && removedEntries < entries.length) {
    const remainingBytes = currentSizeBytes - targetSizeBytes;
    let batchBytes = 0;
    while (removedEntries < entries.length && batchBytes < remainingBytes + safetyPaddingBytes) {
      const entry = entries[removedEntries];
      deleteEntry(cache, entry);
      batchBytes += entry.estimatedBytes;
      removedEntries += 1;
    }
    currentSizeBytes = serializedSize(cache);
  }

  return {
    afterSizeBytes: currentSizeBytes,
    removedEntries,
  };
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function trimReasoningCache() {
  const { cachePath, maxSizeBytes, targetSizeBytes } = loadTrimConfig();
  if (!fs.existsSync(cachePath)) {
    return {
      ok: true,
      cachePath,
      message: "Cache file not found.",
      maxSizeBytes,
      targetSizeBytes,
      beforeSizeBytes: 0,
      afterSizeBytes: 0,
      removedEntries: 0,
    };
  }

  if (maxSizeBytes <= 0) {
    const cache = readJson(cachePath);
    const size = serializedSize(cache);
    return {
      ok: true,
      cachePath,
      message: "Cache max size is disabled.",
      maxSizeBytes,
      targetSizeBytes: 0,
      beforeSizeBytes: size,
      afterSizeBytes: size,
      removedEntries: 0,
    };
  }

  const cache = readJson(cachePath);
  if (!cache || typeof cache !== "object") {
    throw new Error("Reasoning cache must be a JSON object.");
  }

  const beforeSizeBytes = serializedSize(cache);
  let { afterSizeBytes, removedEntries } = trimCacheToTargetSize(
    cache,
    targetSizeBytes,
    beforeSizeBytes,
  );

  if (removedEntries > 0) {
    cache.version = 2;
    cache.updatedAt = Date.now();
    cache.maxSizeBytes = maxSizeBytes;
    afterSizeBytes = serializedSize(cache);

    // Metadata updates are tiny, but they can push very small test caches back
    // over the target. Delete one final estimated batch if that happens.
    if (afterSizeBytes > targetSizeBytes) {
      const finalTrim = trimCacheToTargetSize(cache, targetSizeBytes, afterSizeBytes);
      afterSizeBytes = finalTrim.afterSizeBytes;
      removedEntries += finalTrim.removedEntries;
    }
    writeJsonAtomic(cachePath, cache);
  }

  return {
    ok: true,
    cachePath,
    maxSizeBytes,
    targetSizeBytes,
    beforeSizeBytes,
    afterSizeBytes,
    removedEntries,
  };
}

try {
  process.stdout.write(`${JSON.stringify(trimReasoningCache())}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, message: error.message })}\n`);
  process.exitCode = 1;
}
