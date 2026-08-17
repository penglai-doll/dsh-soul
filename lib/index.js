// dsh-soul — Host half (v0.2).
//
// A file-backed "living soul" for DeepSeek Harness. It reads one trusted
// SOUL.md-style markdown file (default: `$DSH_HOME/SOUL.md`, or a configured
// path) and registers its content as an ordered system-prompt section.
// System-prompt sections are assembled for every model request and are not
// compacted away, which is exactly the persistence model expected from a
// SOUL.md-style file.
//
// v0.2 adds the other half of the OpenClaw/Hermes SOUL.md effect: the agent
// maintains the file itself. Four tools are registered —
// `soul_view`, `soul_remember`, `soul_edit`, `soul_rewrite` — so durable
// preferences and memories can evolve across sessions. The section is also
// re-read at the start of every session (`agent/session-start`), so editing
// the file takes effect without a process restart.
//
// v0.3 adds a management UI. When a `webServer` service is mounted, the plugin
// serves a same-origin JSON API under `/soul` (GET reads the current soul,
// POST /soul/save replaces it under the same byte budget) that the client
// half renders as a settings page.
//
// The plugin never discovers SOUL.md inside arbitrary workspaces: a cloned
// repository must not be able to change the agent's persona simply by
// containing a SOUL.md. File contents are trusted prompt injection by design,
// so the configured path should point only at a file the user owns.

import { createReadStream } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const name = "dsh-soul";
export const inject = ["systemPrompt", "tools"];

const DEFAULT_HOME_DIR = ".dsh";
const DSH_HOME_ENV = "DSH_HOME";
const SOUL_FILE_NAME = "SOUL.md";
const DEFAULT_SECTION_NAME = "soul:persona";
const DEFAULT_SECTION_ORDER = 1;
const TOOL_GUIDANCE_SECTION = "tool:soul";
const TOOL_GUIDANCE_ORDER = 101;

function isMissingNodeError(error) {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function expandHomePath(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Resolve the DeepSeek Harness home directory.
 *
 * Precedence, highest first: explicit `configured`, non-blank `$DSH_HOME`,
 * then `~/.dsh`. Mirrors @deepseek-ai/dsh-home-paths closely enough for this
 * plugin without taking another runtime dependency.
 */
export function resolveDshHome(configured, env = process.env) {
  const fromEnv = env?.[DSH_HOME_ENV];
  const selected = configured !== undefined
    ? configured
    : typeof fromEnv === "string" && fromEnv.trim() !== ""
      ? fromEnv
      : join(homedir(), DEFAULT_HOME_DIR);
  return resolve(expandHomePath(selected));
}

function resolveConfiguredPath(path, cwd) {
  const expanded = expandHomePath(path);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/**
 * Normalize and validate plugin config.
 *
 * `maxBytes` is intentionally required: the loaded text is repeated in the
 * system prompt for every request, so the budget must be an explicit choice.
 */
export function resolveConfig(config = {}, env = process.env, cwd = process.cwd()) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new TypeError("dsh-soul: config must be an object");
  }

  const maxBytes = config.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("dsh-soul: config.maxBytes must be a positive integer");
  }

  const sectionName = config.sectionName ?? DEFAULT_SECTION_NAME;
  if (typeof sectionName !== "string" || sectionName.trim() === "") {
    throw new TypeError("dsh-soul: config.sectionName must be a non-empty string");
  }

  const order = config.order ?? DEFAULT_SECTION_ORDER;
  if (typeof order !== "number" || !Number.isFinite(order)) {
    throw new TypeError("dsh-soul: config.order must be a finite number");
  }

  if (config.complete !== undefined && typeof config.complete !== "boolean") {
    throw new TypeError("dsh-soul: config.complete must be a boolean");
  }

  if (config.tools !== undefined && typeof config.tools !== "boolean") {
    throw new TypeError("dsh-soul: config.tools must be a boolean");
  }

  if (config.dshHome !== undefined && (typeof config.dshHome !== "string" || config.dshHome.trim() === "")) {
    throw new TypeError("dsh-soul: config.dshHome must be a non-empty string");
  }

  const complete = config.complete === true;
  const dshHome = resolveDshHome(config.dshHome, env);
  const configuredFile = config.file ?? join(dshHome, SOUL_FILE_NAME);
  if (typeof configuredFile !== "string" || configuredFile.trim() === "") {
    throw new TypeError("dsh-soul: config.file must be a non-empty string");
  }

  return {
    file: resolveConfiguredPath(configuredFile, cwd),
    maxBytes,
    sectionName: sectionName.trim(),
    order,
    complete,
    tools: config.tools !== false,
    dshHome,
  };
}

function unavailable(error) {
  return { kind: "unavailable", error };
}

async function readWithFileSystem(fileSystem, file, maxBytes) {
  let target;
  try {
    target = await fileSystem.resolve(file);
  } catch (error) {
    return unavailable(error);
  }

  let info;
  try {
    info = await fileSystem.stat(target);
  } catch (error) {
    return unavailable(error);
  }
  if (info === undefined) return { kind: "absent" };
  if (info.type !== "file") return { kind: "not-file" };
  if (info.size !== undefined && info.size > maxBytes) return { kind: "too-large", size: info.size };

  try {
    const chunks = await fileSystem.streamText(target);
    const parts = [];
    let bytes = 0;
    for await (const chunk of chunks) {
      const text = String(chunk);
      bytes += Buffer.byteLength(text, "utf8");
      if (bytes > maxBytes) return { kind: "too-large" };
      parts.push(text);
    }
    return { kind: "ok", text: parts.join("") };
  } catch (error) {
    return unavailable(error);
  }
}

async function readWithNode(file, maxBytes) {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    return isMissingNodeError(error) ? { kind: "absent" } : unavailable(error);
  }
  if (!info.isFile()) return { kind: "not-file" };
  if (info.size > maxBytes) return { kind: "too-large", size: info.size };

  try {
    const stream = createReadStream(file, { encoding: "utf8" });
    const parts = [];
    let bytes = 0;
    for await (const chunk of stream) {
      const text = String(chunk);
      bytes += Buffer.byteLength(text, "utf8");
      if (bytes > maxBytes) return { kind: "too-large" };
      parts.push(text);
    }
    return { kind: "ok", text: parts.join("") };
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * Read one SOUL file with a hard byte limit.
 *
 * When the host exposes a `ctx.fs` provider, the read goes through that seam;
 * otherwise Node's host filesystem is used. The result object intentionally
 * stays tiny and serializable-ish so tests can assert against it directly.
 */
export function loadSoulFile(file, maxBytes, fileSystem) {
  return fileSystem === undefined
    ? readWithNode(file, maxBytes)
    : readWithFileSystem(fileSystem, file, maxBytes);
}

function warn(ctx, message) {
  const text = `dsh-soul: ${message}`;
  if (typeof ctx?.logger?.warn === "function") ctx.logger.warn(text);
  else console.warn(text);
}

// ---------------------------------------------------------------------------
// Soul document helpers (pure, exported for tests)
// ---------------------------------------------------------------------------

/** Local date stamp for memory entries: YYYY-MM-DD. */
export function todayStamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function isHeading(line) {
  return /^##\s/.test(line.trim());
}

/**
 * Append one memory line to soul text.
 *
 * Without `section`, the line lands at the end of the document. With a
 * `section`, it is filed under that `## ` heading: an existing heading is
 * reused and the entry is appended to its body; a missing heading is created
 * at the end of the document. Entries are normalized to a single line.
 */
export function appendEntry(text, entry, section) {
  const cleanEntry = String(entry).trim().replace(/\s+/g, " ");
  const line = `- ${todayStamp()} — ${cleanEntry}`;
  const base = String(text).trimEnd();

  if (section === undefined) {
    return base.length > 0 ? `${base}\n\n${line}\n` : `${line}\n`;
  }

  const heading = `## ${String(section).trim()}`;
  const lines = base.length > 0 ? base.split("\n") : [];
  const headingIndex = lines.findIndex((lineText) => lineText.trim() === heading);

  if (headingIndex === -1) {
    return `${base.length > 0 ? `${base}\n\n` : ""}${heading}\n\n${line}\n`;
  }

  let bodyStart = headingIndex + 1;
  while (bodyStart < lines.length && lines[bodyStart].trim() === "") bodyStart += 1;
  let bodyEnd = bodyStart;
  while (bodyEnd < lines.length && !isHeading(lines[bodyEnd])) bodyEnd += 1;

  // Insert at the end of the section body, preserving the blank lines that
  // separate this section from the next heading.
  let insertAt = bodyEnd;
  while (insertAt > bodyStart && lines[insertAt - 1].trim() === "") insertAt -= 1;

  const next = [...lines.slice(0, insertAt), line, ...lines.slice(insertAt)];
  return `${next.join("\n").trimEnd()}\n`;
}

/**
 * Replace the unique occurrence of `oldText` with `newText`.
 *
 * Returns `{ kind: "ok", text }`, `{ kind: "not-found" }`, or
 * `{ kind: "multiple", count }` so the caller can pick a clear model error.
 */
export function replaceFirst(text, oldText, newText) {
  const count = text.split(oldText).length - 1;
  if (count === 0) return { kind: "not-found" };
  if (count > 1) return { kind: "multiple", count };
  const index = text.indexOf(oldText);
  return { kind: "ok", text: text.slice(0, index) + newText + text.slice(index + oldText.length) };
}

/**
 * Enforce the byte budget on a candidate soul text; throws with a compaction
 * hint when the text would exceed it.
 */
export function ensureWithin(text, maxBytes) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`dsh-soul: new SOUL.md content is ${bytes} bytes, over maxBytes=${maxBytes}; rewrite it more compactly or raise maxBytes`);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Maintenance reads and writes
// ---------------------------------------------------------------------------

function soulLoadError(loaded, file) {
  switch (loaded.kind) {
    case "not-file":
      return new Error(`dsh-soul: SOUL file is not a regular file: ${file}`);
    case "too-large":
      return new Error(`dsh-soul: SOUL file exceeds maxBytes (${file}); use soul_rewrite to compact it first`);
    case "unavailable":
      return new Error(`dsh-soul: cannot read SOUL file: ${file} — ${loaded.error instanceof Error ? loaded.error.message : String(loaded.error)}`);
    default:
      return new Error(`dsh-soul: unexpected SOUL load result: ${loaded.kind}`);
  }
}

/** Read the current soul text for a mutation; absent maps to `{ kind: "absent" }`. */
async function readCurrent(fileSystem, file, maxBytes) {
  const loaded = await loadSoulFile(file, maxBytes, fileSystem);
  switch (loaded.kind) {
    case "ok":
      return { kind: "ok", text: loaded.text };
    case "absent":
      return { kind: "absent" };
    default:
      throw soulLoadError(loaded, file);
  }
}

/** Resolve the calling session's standing sandbox policy, or undefined without the service. */
async function resolvePolicy(sandboxPolicyService, exec) {
  if (sandboxPolicyService === undefined) return undefined;
  return sandboxPolicyService.resolve({ ...(exec.agent ? { session: exec.agent.session } : {}) });
}

/**
 * Write the soul text through the host `fs` provider: resolve, ask the single
 * `fs/write-intent` slot for a version guard, write atomically under the
 * session's sandbox policy, then record the observation.
 */
async function writeWithFileSystem(ctx, fileSystem, sandboxPolicyService, exec, file, content) {
  const target = await fileSystem.resolve(file, { signal: exec.signal });
  const policy = await resolvePolicy(sandboxPolicyService, exec);
  const intent = await ctx.waterfall("fs/write-intent", target, exec, () => undefined);
  const outcome = await fileSystem.writeText(target, content, intent, exec.signal, policy);
  ctx.emit("fs/observed", target, { kind: "present", version: outcome.version }, exec);
  return outcome;
}

/** Node-filesystem fallback write: temp file + atomic rename, parents created. */
async function writeWithNode(file, content) {
  await mkdir(dirname(file), { recursive: true });
  let exists = false;
  try {
    exists = (await stat(file)).isFile();
  } catch (error) {
    if (!isMissingNodeError(error)) throw error;
  }
  const tmp = `${file}.dsh-soul-${process.pid}-${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  return { operation: exists ? "update" : "create" };
}

/** Size-checked soul write; provider path when available, node fallback otherwise. */
async function writeSoulText(ctx, fileSystem, sandboxPolicyService, exec, file, maxBytes, content) {
  ensureWithin(content, maxBytes);
  return fileSystem === undefined
    ? writeWithNode(file, content)
    : writeWithFileSystem(ctx, fileSystem, sandboxPolicyService, exec, file, content);
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const TOOL_GUIDANCE_TEXT = [
  "You have a persistent soul file (SOUL.md) that dsh-soul injects into your system prompt for every model request. Maintain it as your cross-session persona and memory:",
  "- Use soul_view to read it before larger changes.",
  "- Use soul_remember to record durable facts, user preferences, and lessons that should persist across sessions.",
  "- Use soul_edit for one targeted correction.",
  "- Use soul_rewrite to compact or restructure the file when it approaches its byte limit.",
  "Keep entries factual and concise; the file is re-read at the start of every session.",
].join("\n");

/**
 * Register the four soul-maintenance tools plus a guidance section.
 *
 * The tools need the host `fs` provider (they are read-modify-write against
 * one fixed path); without one, only the static persona section is mounted.
 */
function applyTools(ctx, resolved, fileSystem, sandboxPolicyService) {
  if (fileSystem === undefined) {
    warn(ctx, "maintenance tools skipped: no host fs provider is mounted");
    return;
  }

  ctx.effect(() => ctx.tools.register({
    name: "soul_view",
    description: "Read the current SOUL.md content — your persistent cross-session persona and memory file.",
    parameters: { type: "object", properties: {} },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          exists: { type: "boolean" },
          text: { type: "string" },
          bytes: { type: "number" },
          maxBytes: { type: "number" },
        },
        required: ["exists", "text", "bytes", "maxBytes"],
      },
      render(_args, value) {
        return [{
          type: "text",
          text: value.exists
            ? `SOUL.md (${value.bytes} / ${value.maxBytes} bytes)\n\n${value.text}`
            : `SOUL.md does not exist yet (${resolved.file}). Use soul_remember or soul_rewrite to create it.`,
        }];
      },
    },
    async execute(_args, exec) {
      const target = await fileSystem.resolve(resolved.file, { signal: exec.signal });
      const info = await fileSystem.stat(target, exec.signal);
      if (info === undefined) {
        ctx.emit("fs/observed", target, { kind: "absent" }, exec);
        return { exists: false, text: "", bytes: 0, maxBytes: resolved.maxBytes };
      }
      if (info.type !== "file") throw new Error(`dsh-soul: SOUL file is not a regular file: ${resolved.file}`);
      const loaded = await loadSoulFile(resolved.file, resolved.maxBytes, fileSystem);
      if (loaded.kind !== "ok") throw soulLoadError(loaded, resolved.file);
      ctx.emit("fs/observed", target, { kind: "present", version: info.version }, exec);
      return {
        exists: true,
        text: loaded.text,
        bytes: Buffer.byteLength(loaded.text, "utf8"),
        maxBytes: resolved.maxBytes,
      };
    },
  }), "dsh-soul: tool soul_view");

  ctx.effect(() => ctx.tools.register({
    name: "soul_remember",
    description: "Append one durable fact, preference, or memory to SOUL.md so it persists across sessions.",
    parameters: {
      type: "object",
      properties: {
        entry: {
          type: "string",
          description: "One concise durable fact to remember. It becomes a single dated line in SOUL.md.",
        },
        section: {
          type: "string",
          description: "Optional `## ` section heading to file the entry under; created when missing.",
        },
      },
      required: ["entry"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: { type: "string", enum: ["create", "update"] },
          bytes: { type: "number" },
          entry: { type: "string" },
          section: { oneOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["operation", "bytes", "entry", "section"],
      },
      render(_args, value) {
        const where = value.section === null ? "the end of the file" : `the "${value.section}" section`;
        return [{
          type: "text",
          text: `Remembered in SOUL.md (${value.bytes} / ${resolved.maxBytes} bytes, ${where}): ${value.entry}`,
        }];
      },
    },
    async execute(args, exec) {
      const entry = typeof args.entry === "string" ? args.entry.trim() : "";
      if (entry === "") throw new Error("entry must be a non-empty string");
      const section = typeof args.section === "string" && args.section.trim() !== "" ? args.section.trim() : undefined;
      const current = await readCurrent(fileSystem, resolved.file, resolved.maxBytes);
      const next = appendEntry(current.kind === "absent" ? "" : current.text, entry, section);
      const outcome = await writeSoulText(ctx, fileSystem, sandboxPolicyService, exec, resolved.file, resolved.maxBytes, next);
      return {
        operation: outcome.operation,
        bytes: Buffer.byteLength(next, "utf8"),
        entry,
        section: section ?? null,
      };
    },
  }), "dsh-soul: tool soul_remember");

  ctx.effect(() => ctx.tools.register({
    name: "soul_edit",
    description: "Edit SOUL.md by replacing one literal occurrence of oldText with newText.",
    parameters: {
      type: "object",
      properties: {
        oldText: {
          type: "string",
          description: "Literal text to replace in SOUL.md. Must match exactly once.",
        },
        newText: {
          type: "string",
          description: "Replacement text. Use an empty string to delete the matched text.",
        },
      },
      required: ["oldText", "newText"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: { type: "string", enum: ["create", "update"] },
          bytes: { type: "number" },
        },
        required: ["operation", "bytes"],
      },
      render(_args, value) {
        return [{ type: "text", text: `SOUL.md edited (${value.bytes} / ${resolved.maxBytes} bytes).` }];
      },
    },
    async execute(args, exec) {
      const oldText = typeof args.oldText === "string" ? args.oldText : "";
      const newText = typeof args.newText === "string" ? args.newText : "";
      if (oldText === "") throw new Error("oldText must be a non-empty string");
      if (oldText === newText) throw new Error("oldText and newText must differ");
      const current = await readCurrent(fileSystem, resolved.file, resolved.maxBytes);
      if (current.kind === "absent") {
        throw new Error(`dsh-soul: SOUL.md does not exist yet (${resolved.file}); use soul_rewrite or soul_remember first`);
      }
      const replaced = replaceFirst(current.text, oldText, newText);
      if (replaced.kind === "not-found") throw new Error("oldText was not found in SOUL.md");
      if (replaced.kind === "multiple") {
        throw new Error(`oldText appears ${replaced.count} times in SOUL.md; make it more specific or use soul_rewrite`);
      }
      const outcome = await writeSoulText(ctx, fileSystem, sandboxPolicyService, exec, resolved.file, resolved.maxBytes, replaced.text);
      return { operation: outcome.operation, bytes: Buffer.byteLength(replaced.text, "utf8") };
    },
  }), "dsh-soul: tool soul_edit");

  ctx.effect(() => ctx.tools.register({
    name: "soul_rewrite",
    description: "Replace the entire SOUL.md with new content. Use this to create, compact, or restructure the soul.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The complete new SOUL.md content.",
        },
      },
      required: ["content"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: { type: "string", enum: ["create", "update"] },
          bytes: { type: "number" },
        },
        required: ["operation", "bytes"],
      },
      render(_args, value) {
        return [{ type: "text", text: `SOUL.md rewritten (${value.bytes} / ${resolved.maxBytes} bytes).` }];
      },
    },
    async execute(args, exec) {
      const content = typeof args.content === "string" ? args.content : "";
      if (content.trim() === "") throw new Error("content must be a non-blank string");
      const outcome = await writeSoulText(ctx, fileSystem, sandboxPolicyService, exec, resolved.file, resolved.maxBytes, content);
      return { operation: outcome.operation, bytes: Buffer.byteLength(content, "utf8") };
    },
  }), "dsh-soul: tool soul_rewrite");

  ctx.effect(() => ctx.systemPrompt.section({
    name: TOOL_GUIDANCE_SECTION,
    order: TOOL_GUIDANCE_ORDER,
    text: TOOL_GUIDANCE_TEXT,
  }), "dsh-soul: tool guidance section");
}

// ---------------------------------------------------------------------------
// Web management API
// ---------------------------------------------------------------------------

function errText(error) {
  if (error == null) return "unknown error";
  if (typeof error === "object" && error.message != null) return String(error.message);
  return String(error);
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 1 << 20) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** UI save: the same byte budget as the tools, but no model exec context. */
async function writeSoulForUi(fileSystem, sandboxPolicyService, file, maxBytes, content) {
  ensureWithin(content, maxBytes);
  if (fileSystem === undefined) {
    await writeWithNode(file, content);
    return;
  }
  const target = await fileSystem.resolve(file);
  const policy = sandboxPolicyService === undefined ? undefined : sandboxPolicyService.resolve({});
  await fileSystem.writeText(target, content, undefined, undefined, policy);
}

/**
 * Same-origin JSON API for the client half: `GET /soul` reads the current
 * soul and `POST /soul/save` replaces it. Same trust boundary as the Web UI
 * itself — keep the deployment on loopback.
 */
function applyWebRoutes(ctx, resolved, fileSystem, sandboxPolicyService, webServer) {
  ctx.effect(() => webServer.register({
    kind: "prefix",
    path: "/soul",
    handler: async (req, res) => {
      let pathname = req.url || "/";
      const q = pathname.indexOf("?");
      if (q >= 0) pathname = pathname.slice(0, q);
      const method = req.method || "GET";
      try {
        if (pathname === "/soul" && method === "GET") {
          const loaded = await loadSoulFile(resolved.file, resolved.maxBytes, fileSystem);
          switch (loaded.kind) {
            case "ok":
              return sendJson(res, 200, {
                ok: true,
                exists: true,
                text: loaded.text,
                bytes: Buffer.byteLength(loaded.text, "utf8"),
                maxBytes: resolved.maxBytes,
                file: resolved.file,
              });
            case "absent":
              return sendJson(res, 200, {
                ok: true,
                exists: false,
                text: "",
                bytes: 0,
                maxBytes: resolved.maxBytes,
                file: resolved.file,
              });
            case "not-file":
              return sendJson(res, 409, { ok: false, error: `SOUL 文件不是普通文件: ${resolved.file}` });
            case "too-large":
              return sendJson(res, 413, { ok: false, error: `SOUL 文件超过 maxBytes=${resolved.maxBytes}` });
            default:
              return sendJson(res, 500, { ok: false, error: `无法读取 SOUL 文件: ${resolved.file} — ${errText(loaded.error)}` });
          }
        }
        if (pathname === "/soul/save" && method === "POST") {
          const body = await readBody(req);
          const content = typeof body.content === "string" ? body.content : "";
          if (content.trim() === "") return sendJson(res, 400, { ok: false, error: "content 不能为空" });
          try {
            await writeSoulForUi(fileSystem, sandboxPolicyService, resolved.file, resolved.maxBytes, content);
            return sendJson(res, 200, { ok: true, bytes: Buffer.byteLength(content, "utf8") });
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: errText(error) });
          }
        }
        return sendJson(res, 404, { ok: false, error: "未知的 /soul 路由: " + method + " " + pathname });
      } catch (error) {
        warn(ctx, `web route failed: ${method} ${pathname} — ${errText(error)}`);
        return sendJson(res, 500, { ok: false, error: errText(error) });
      }
    },
  }), "dsh-soul: /soul routes");
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export async function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const fileSystem = typeof ctx.get === "function" ? ctx.get("fs") : undefined;
  const sandboxPolicyService = typeof ctx.get === "function" ? ctx.get("sandboxPolicy") : undefined;

  // --- persona section, re-read at the start of every session ---
  const active = { text: null, dispose: null };

  async function refresh() {
    const loaded = await loadSoulFile(resolved.file, resolved.maxBytes, fileSystem);
    let nextText;
    switch (loaded.kind) {
      case "ok":
        nextText = loaded.text;
        break;
      case "absent":
      case "not-file":
        // Soul removed or replaced by a non-file: drop the section silently.
        nextText = null;
        break;
      case "too-large":
        warn(ctx, `SOUL file exceeds maxBytes=${resolved.maxBytes}, keeping previous soul: ${resolved.file}`);
        return;
      case "unavailable":
        warn(ctx, `cannot read SOUL file, keeping previous soul: ${resolved.file} — ${loaded.error instanceof Error ? loaded.error.message : String(loaded.error)}`);
        return;
      /* v8 ignore next 2 -- closed result vocabulary; this arm is unreachable. */
      default:
        warn(ctx, `unexpected SOUL load result: ${loaded.kind}`);
        return;
    }

    if (nextText === active.text) return;
    if (active.dispose !== null) {
      active.dispose();
      active.dispose = null;
    }
    active.text = nextText;
    if (nextText !== null) {
      active.dispose = ctx.systemPrompt.section({
        name: resolved.sectionName,
        order: resolved.order,
        text: nextText,
        ...(resolved.complete ? { complete: true } : {}),
      });
    }
  }

  await refresh();

  // Serialize refreshes so overlapping session starts cannot interleave reads.
  let queue = Promise.resolve();
  ctx.on("agent/session-start", () => {
    queue = queue.then(() => refresh()).catch(() => {});
  });

  ctx.effect(() => () => {
    if (active.dispose !== null) active.dispose();
    active.dispose = null;
    active.text = null;
  }, "dsh-soul: section lifecycle");

  if (resolved.tools) {
    applyTools(ctx, resolved, fileSystem, sandboxPolicyService);
  }

  const webServer = typeof ctx.get === "function" ? ctx.get("webServer") : undefined;
  if (webServer !== undefined) {
    applyWebRoutes(ctx, resolved, fileSystem, sandboxPolicyService, webServer);
  }
}
