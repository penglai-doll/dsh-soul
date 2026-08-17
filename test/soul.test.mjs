import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  appendEntry,
  apply,
  ensureWithin,
  loadSoulFile,
  replaceFirst,
  resolveConfig,
  todayStamp,
} from "../lib/index.js";

function fakeFileSystem(text, overrides = {}) {
  const state = { text, writes: [] };
  return {
    async resolve(path) {
      return { path };
    },
    async stat() {
      return state.text === undefined
        ? undefined
        : { type: "file", size: Buffer.byteLength(state.text, "utf8"), version: state.writes.length + 1 };
    },
    async streamText() {
      return (async function* () {
        yield state.text;
      })();
    },
    async writeText(_target, content) {
      const operation = state.text === undefined ? "create" : "update";
      state.text = content;
      state.writes.push(content);
      return { operation, version: state.writes.length + 1 };
    },
    state,
    ...overrides,
  };
}

function mockContext(fileSystem) {
  const listeners = {};
  const ctx = {
    sections: [],
    sectionDisposals: [],
    registeredTools: [],
    routes: [],
    effects: [],
    fileSystem,
    get(name) {
      if (name === "fs") return fileSystem;
      if (name === "sandboxPolicy") {
        return {
          resolve(request) {
            return { mode: "danger-full-access", request };
          },
        };
      }
      if (name === "webServer") {
        return {
          register(route) {
            ctx.routes.push(route);
            return () => {};
          },
        };
      }
      return undefined;
    },
    systemPrompt: {
      section(section) {
        ctx.sections.push(section);
        return () => {
          ctx.sectionDisposals.push(section.name);
        };
      },
    },
    tools: {
      register(definition) {
        ctx.registeredTools.push(definition);
        return () => {};
      },
    },
    on(name, callback) {
      listeners[name] = callback;
      return () => {
        delete listeners[name];
      };
    },
    async waterfall() {
      return undefined;
    },
    emit() {},
    effect(callback, label) {
      ctx.effects.push(label);
      const dispose = callback();
      return () => {
        if (typeof dispose === "function") dispose();
      };
    },
    logger: {
      warn() {},
    },
  };
  ctx.emitSessionStart = () => {
    const listener = listeners["agent/session-start"];
    if (listener !== undefined) listener();
  };
  ctx.tool = (name) => ctx.registeredTools.find((definition) => definition.name === name);
  return ctx;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

// --- config (v0.1 coverage kept) ---

test("resolveConfig defaults to $DSH_HOME/SOUL.md", () => {
  const home = join(tmpdir(), "dsh-soul-home");
  const config = resolveConfig({ maxBytes: 1024 }, { DSH_HOME: home });
  assert.equal(config.file, resolve(home, "SOUL.md"));
  assert.equal(config.sectionName, "soul:persona");
  assert.equal(config.order, 1);
  assert.equal(config.complete, false);
  assert.equal(config.maxBytes, 1024);
});

test("resolveConfig expands a tilde path", () => {
  const config = resolveConfig({ maxBytes: 1024, file: "~/soul/SOUL.md" });
  assert.equal(config.file, join(homedir(), "soul", "SOUL.md"));
});

test("resolveConfig rejects a missing or invalid maxBytes", () => {
  assert.throws(() => resolveConfig({}), /maxBytes/);
  assert.throws(() => resolveConfig({ maxBytes: 0 }), /maxBytes/);
  assert.throws(() => resolveConfig({ maxBytes: 1.5 }), /maxBytes/);
});

test("resolveConfig validates the tools flag", () => {
  assert.equal(resolveConfig({ maxBytes: 1024 }).tools, true);
  assert.equal(resolveConfig({ maxBytes: 1024, tools: false }).tools, false);
  assert.throws(() => resolveConfig({ maxBytes: 1024, tools: "yes" }), /tools/);
});

// --- reading ---

test("loadSoulFile reads a bounded file through ctx.fs", async () => {
  const fs = fakeFileSystem("你好，SOUL");
  const result = await loadSoulFile("SOUL.md", 1024, fs);
  assert.equal(result.kind, "ok");
  assert.equal(result.text, "你好，SOUL");
});

test("loadSoulFile rejects an oversized file through ctx.fs", async () => {
  const fs = fakeFileSystem("too long");
  const result = await loadSoulFile("SOUL.md", 3, fs);
  assert.equal(result.kind, "too-large");
});

test("loadSoulFile falls back to Node filesystem when no provider is supplied", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-soul-"));
  const file = join(dir, "SOUL.md");
  try {
    await writeFile(file, "fallback soul", "utf8");
    const result = await loadSoulFile(file, 1024);
    assert.equal(result.kind, "ok");
    assert.equal(result.text, "fallback soul");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- pure soul document helpers ---

test("todayStamp formats YYYY-MM-DD", () => {
  assert.equal(todayStamp(new Date(2026, 0, 5)), "2026-01-05");
});

test("appendEntry creates the first line of an empty soul", () => {
  const text = appendEntry("", "prefer concise answers");
  assert.match(text, /^- \d{4}-\d{2}-\d{2} — prefer concise answers\n$/);
});

test("appendEntry appends to an existing document", () => {
  const text = appendEntry("# Soul\n\nHello", "prefer concise answers");
  assert.match(text, /^# Soul\n\nHello\n\n- \d{4}-\d{2}-\d{2} — prefer concise answers\n$/);
});

test("appendEntry creates a missing section at the end", () => {
  const text = appendEntry("Hello", "fact one", "Memories");
  assert.match(text, /^Hello\n\n## Memories\n\n- \d{4}-\d{2}-\d{2} — fact one\n$/);
});

test("appendEntry files an entry under an existing heading", () => {
  const base = "## Identity\n\nyou are x\n\n## Memories\n\n- 2026-01-01 — old\n\n## Preferences\n\nquiet";
  const text = appendEntry(base, "new fact", "Memories");
  assert.match(
    text,
    /^## Identity\n\nyou are x\n\n## Memories\n\n- 2026-01-01 — old\n- \d{4}-\d{2}-\d{2} — new fact\n\n## Preferences\n\nquiet\n$/,
  );
});

test("appendEntry normalizes multi-line entries to one line", () => {
  const text = appendEntry("", "line one\nline two", "Memories");
  assert.ok(text.includes("line one line two"));
  assert.ok(!text.includes("\nline two"));
});

test("replaceFirst replaces a unique occurrence", () => {
  assert.deepEqual(replaceFirst("a b c", "b", "B"), { kind: "ok", text: "a B c" });
});

test("replaceFirst reports not-found and multiple", () => {
  assert.deepEqual(replaceFirst("abc", "z", "y"), { kind: "not-found" });
  assert.deepEqual(replaceFirst("a a", "a", "b"), { kind: "multiple", count: 2 });
});

test("ensureWithin returns bytes inside the budget and throws beyond it", () => {
  assert.equal(ensureWithin("abcd", 10), 4);
  assert.throws(() => ensureWithin("abcdef", 3), /over maxBytes/);
});

// --- apply: persona section ---

test("apply registers the loaded text as a system prompt section plus tools", async () => {
  const ctx = mockContext(fakeFileSystem("You are Neptune."));
  await apply(ctx, { maxBytes: 1024 });
  assert.equal(ctx.sections.length, 2);
  assert.deepEqual(ctx.sections[0], {
    name: "soul:persona",
    order: 1,
    text: "You are Neptune.",
  });
  assert.equal(ctx.sections[1].name, "tool:soul");
  assert.deepEqual(
    ctx.registeredTools.map((definition) => definition.name).sort(),
    ["soul_edit", "soul_remember", "soul_rewrite", "soul_view"],
  );
  assert.ok(ctx.effects.includes("dsh-soul: section lifecycle"));
});

test("apply supports a preset-scoped persona shadow", async () => {
  const ctx = mockContext(fakeFileSystem("You are Purple Heart."));
  await apply(ctx, {
    maxBytes: 1024,
    sectionName: "deployment:persona",
    order: 0,
    complete: true,
  });
  assert.deepEqual(ctx.sections[0], {
    name: "deployment:persona",
    order: 0,
    text: "You are Purple Heart.",
    complete: true,
  });
});

test("apply is a no-op section when the SOUL file is absent but tools remain", async () => {
  const ctx = mockContext(fakeFileSystem(undefined));
  await apply(ctx, { maxBytes: 1024 });
  assert.equal(ctx.sections.length, 1); // tool:soul guidance only
  assert.equal(ctx.sections[0].name, "tool:soul");
  assert.equal(ctx.registeredTools.length, 4);
});

test("apply with tools:false registers no maintenance tools", async () => {
  const ctx = mockContext(fakeFileSystem("static soul"));
  await apply(ctx, { maxBytes: 1024, tools: false });
  assert.equal(ctx.registeredTools.length, 0);
  assert.equal(ctx.sections.length, 1);
  assert.equal(ctx.sections[0].name, "soul:persona");
});

test("apply re-reads the soul on session start and replaces the section", async () => {
  const fs = fakeFileSystem("soul v1");
  const ctx = mockContext(fs);
  await apply(ctx, { maxBytes: 1024 });
  assert.equal(ctx.sections[0].text, "soul v1");

  fs.state.text = "soul v2";
  ctx.emitSessionStart();
  await flush();

  assert.equal(ctx.sections.length, 3); // v1, guidance, v2
  assert.equal(ctx.sections.at(-1).text, "soul v2");
  assert.ok(ctx.sectionDisposals.includes("soul:persona"), "old section was disposed");
});

test("apply drops the section when the soul file is deleted", async () => {
  const fs = fakeFileSystem("soul v1");
  const ctx = mockContext(fs);
  await apply(ctx, { maxBytes: 1024 });
  assert.equal(ctx.sections[0].text, "soul v1");

  fs.state.text = undefined;
  ctx.emitSessionStart();
  await flush();

  assert.equal(ctx.sections.at(-1).name, "tool:soul"); // no replacement section was registered
  assert.ok(ctx.sectionDisposals.includes("soul:persona"), "old section was disposed");
});

// --- maintenance tools ---

const EXEC = { signal: undefined, agent: undefined };

test("soul_remember appends a dated entry and creates the file when absent", async () => {
  const fs = fakeFileSystem(undefined);
  const ctx = mockContext(fs);
  await apply(ctx, { maxBytes: 1024 });

  const remember = ctx.tool("soul_remember");
  assert.ok(remember);
  const result = await remember.execute({ entry: "prefer dark mode", section: "Preferences" }, EXEC);

  assert.equal(result.operation, "create");
  assert.ok(result.bytes > 0);
  assert.equal(result.section, "Preferences");
  assert.ok(fs.state.text.includes("## Preferences"));
  assert.ok(fs.state.text.includes("prefer dark mode"));
});

test("soul_remember without a section appends to the end", async () => {
  const fs = fakeFileSystem("## Preferences\n\nquiet");
  const ctx = mockContext(fs);
  await apply(ctx, { maxBytes: 1024 });

  const remember = ctx.tool("soul_remember");
  const result = await remember.execute({ entry: "extra fact" }, EXEC);
  assert.equal(result.operation, "update");
  assert.match(fs.state.text, /^## Preferences\n\nquiet\n\n- \d{4}-\d{2}-\d{2} — extra fact\n$/);
});

test("soul_rewrite replaces the whole file and enforces the budget", async () => {
  const fs = fakeFileSystem("old soul");
  const ctx = mockContext(fs);
  await apply(ctx, { maxBytes: 64 });

  const rewrite = ctx.tool("soul_rewrite");
  const result = await rewrite.execute({ content: "# New\n\nfresh" }, EXEC);
  assert.equal(result.operation, "update");
  assert.equal(fs.state.text, "# New\n\nfresh");

  await assert.rejects(() => rewrite.execute({ content: "x".repeat(100) }, EXEC), /over maxBytes/);
  await assert.rejects(() => rewrite.execute({ content: "   " }, EXEC), /non-blank/);
});

test("soul_edit replaces a unique match and rejects missing or multiple matches", async () => {
  const fs = fakeFileSystem("one two one");
  const ctx = mockContext(fs);
  await apply(ctx, { maxBytes: 1024 });

  const edit = ctx.tool("soul_edit");
  const result = await edit.execute({ oldText: "two", newText: "TWO" }, EXEC);
  assert.equal(result.operation, "update");
  assert.equal(fs.state.text, "one TWO one");

  await assert.rejects(() => edit.execute({ oldText: "nope", newText: "x" }, EXEC), /not found/);
  await assert.rejects(() => edit.execute({ oldText: "one", newText: "x" }, EXEC), /appears 2 times/);
});

test("soul_edit refuses to edit a soul that does not exist", async () => {
  const fs = fakeFileSystem(undefined);
  const ctx = mockContext(fs);
  await apply(ctx, { maxBytes: 1024 });
  await assert.rejects(
    () => ctx.tool("soul_edit").execute({ oldText: "a", newText: "b" }, EXEC),
    /does not exist yet/,
  );
});

test("soul_view reports the current soul and observes absence", async () => {
  const fs = fakeFileSystem(undefined);
  const ctx = mockContext(fs);
  await apply(ctx, { maxBytes: 1024 });

  const view = ctx.tool("soul_view");
  const empty = await view.execute({}, EXEC);
  assert.equal(empty.exists, false);

  fs.state.text = "now i exist";
  const full = await view.execute({}, EXEC);
  assert.equal(full.exists, true);
  assert.equal(full.text, "now i exist");
  assert.equal(full.bytes, Buffer.byteLength("now i exist", "utf8"));
});

test("tools are skipped but the persona section still mounts without an fs provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-soul-"));
  const file = join(dir, "SOUL.md");
  try {
    await writeFile(file, "node-fallback soul", "utf8");
    const ctx = mockContext(undefined);
    await apply(ctx, { maxBytes: 1024, file });
    assert.equal(ctx.registeredTools.length, 0);
    assert.equal(ctx.sections.length, 1);
    assert.equal(ctx.sections[0].name, "soul:persona");
    assert.equal(ctx.sections[0].text, "node-fallback soul");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- web management routes ---

function fakeReq(url, method, bodyText) {
  const req = new EventEmitter();
  req.url = url;
  req.method = method;
  process.nextTick(() => {
    if (bodyText !== undefined) req.emit("data", Buffer.from(bodyText, "utf8"));
    req.emit("end");
  });
  return req;
}

function fakeRes() {
  return {
    statusCode: 0,
    body: "",
    setHeader() {},
    end(body) {
      this.body = body;
    },
  };
}

async function callRoute(ctx, req, res) {
  const route = ctx.routes.find((r) => r.path === "/soul");
  assert.ok(route, "/soul route registered");
  await route.handler(req, res);
  return { status: res.statusCode, data: JSON.parse(res.body) };
}

test("GET /soul returns the current soul", async () => {
  const fs = fakeFileSystem("soul text");
  const ctx = mockContext(fs);
  await apply(ctx, { maxBytes: 1024 });

  const { status, data } = await callRoute(ctx, fakeReq("/soul", "GET"), fakeRes());
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.exists, true);
  assert.equal(data.text, "soul text");
  assert.equal(data.bytes, Buffer.byteLength("soul text", "utf8"));
  assert.equal(data.maxBytes, 1024);
});

test("GET /soul reports an absent soul without failing", async () => {
  const fs = fakeFileSystem(undefined);
  const ctx = mockContext(fs);
  await apply(ctx, { maxBytes: 1024 });

  const { status, data } = await callRoute(ctx, fakeReq("/soul", "GET"), fakeRes());
  assert.equal(status, 200);
  assert.equal(data.exists, false);
  assert.equal(data.text, "");
});

test("POST /soul/save writes the soul under the byte budget", async () => {
  const fs = fakeFileSystem("old");
  const ctx = mockContext(fs);
  await apply(ctx, { maxBytes: 1024 });

  const { status, data } = await callRoute(ctx, fakeReq("/soul/save", "POST", JSON.stringify({ content: "new soul" })), fakeRes());
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(fs.state.text, "new soul");

  const over = await callRoute(ctx, fakeReq("/soul/save", "POST", JSON.stringify({ content: "x".repeat(2048) })), fakeRes());
  assert.equal(over.status, 400);
  assert.match(over.data.error, /maxBytes/);
  assert.equal(fs.state.text, "new soul"); // unchanged after rejected save

  const blank = await callRoute(ctx, fakeReq("/soul/save", "POST", JSON.stringify({ content: "   " })), fakeRes());
  assert.equal(blank.status, 400);
});

test("POST /soul/save creates the soul when it is absent", async () => {
  const fs = fakeFileSystem(undefined);
  const ctx = mockContext(fs);
  await apply(ctx, { maxBytes: 1024 });

  const { status } = await callRoute(ctx, fakeReq("/soul/save", "POST", JSON.stringify({ content: "first soul" })), fakeRes());
  assert.equal(status, 200);
  assert.equal(fs.state.text, "first soul");
});

test("unknown /soul routes answer 404", async () => {
  const ctx = mockContext(fakeFileSystem("x"));
  await apply(ctx, { maxBytes: 1024 });
  const { status } = await callRoute(ctx, fakeReq("/soul/other", "GET"), fakeRes());
  assert.equal(status, 404);
});

test("web routes are skipped when no webServer service is mounted", async () => {
  const ctx = mockContext(fakeFileSystem("x"));
  ctx.get = (name) => {
    if (name === "fs") return ctx.fileSystem;
    if (name === "sandboxPolicy") return { resolve() {} };
    return undefined;
  };
  await apply(ctx, { maxBytes: 1024 });
  assert.equal(ctx.routes.length, 0);
  assert.equal(ctx.sections[0].text, "x");
});
