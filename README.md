# dsh-soul

[![GitHub topics: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-7c3aed)](https://github.com/topics/dsh-plugin)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

File-backed **living soul** for DeepSeek Harness: the OpenClaw / Hermes
`SOUL.md` effect, split into the two halves those systems actually have.

1. **Persistent persona.** One trusted `SOUL.md`-style markdown file is
   registered as an ordered system-prompt section. The section is assembled
   for every model request and is never compacted away, and it is re-read at
   the start of every session — edit the file and the next session picks it
   up without restarting the process.
2. **Agent-maintained memory.** Four tools let the agent evolve its own soul
   across sessions, like OpenClaw's soul maintenance:

| Tool | Purpose |
|---|---|
| `soul_view` | Read the current SOUL.md content (plus byte usage). |
| `soul_remember` | Append one dated, durable fact/preference/memory line, optionally filed under a `## ` section. |
| `soul_edit` | Replace one literal occurrence of `oldText` with `newText`. |
| `soul_rewrite` | Replace the whole file — creation, compaction, restructuring. |

A `tool:soul` system-prompt section tells the agent when to use which tool.

3. **Management UI.** When the deployment mounts a `webServer` (the Web
   profile), a collapse/expand **SOUL.md** card appears in the Plugins
   configuration section (设置 → 插件 → 插件配置), alongside the shipped
   bash / agent-loop / web-search cards. The collapsed bar shows the soul's
   byte status and a dirty marker; expanding it opens a textarea editor with
   save / undo / reload over a same-origin JSON API on the same host/port as
   the Web UI itself.

## Web UI and API

The card lives in the plugin configuration section
(`settings.plugin.item`, id `soul`, order 30). The host half serves:

| Route | Purpose |
|---|---|
| `GET /soul` | Current soul: `{ ok, exists, text, bytes, maxBytes, file }`. Absent files report `exists: false`. |
| `POST /soul/save` | Replace the whole soul with `{ content }`. Enforces `maxBytes` and rejects blank content; creates the file when absent. |

The editor warns when the draft exceeds `maxBytes` and the API refuses the
write, so the byte budget holds for every path that mutates the soul
(tools and UI). Saving does not hot-swap the running session's section — the
current session keeps the soul it started with; the next session start picks
up the new content.

## What it does not do

- It never **discovers** `SOUL.md` files in arbitrary project directories: a
  cloned repository must not be able to change the agent's persona. Treat the
  configured path as trusted prompt injection by design.
- It never writes any path other than the single configured file, and every
  write obeys the `maxBytes` budget. Oversized writes are rejected with a
  hint to compact.
- Missing, non-file, oversized, and unreadable inputs never break the
  profile: the persona section is simply absent (or, on transient read
  errors, the previous soul is kept) and tools fail with clear messages.

## Installation

```sh
dsh plugin --profile web add <this-directory>
```

Then add one row to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-soul
      name: 'dsh-soul'
      config:
        maxBytes: 65536
```

Restart `dsh web`. `maxBytes` is required because the text is repeated in the
system prompt for every model request.

## Config

| Field | Default | Meaning |
|---|---|---|
| `maxBytes` | required | Maximum UTF-8 bytes for the SOUL file. Reads and writes over this limit are rejected. |
| `file` | `$DSH_HOME/SOUL.md` | File to load and maintain. `~`, `~/`, and `~\` prefixes expand; relative paths resolve from `process.cwd()`. |
| `dshHome` | `$DSH_HOME`, else `~/.dsh` | Overrides the harness-home used by the default `file` path. |
| `sectionName` | `soul:persona` | System-prompt section name. Use `deployment:persona` only when the row is mounted in an agent preset scope, where it shadows the deployment persona. |
| `order` | `1` | System-prompt section order. `-100` is harness identity, `0` is deployment persona, tool guidance starts around `100`. |
| `complete` | `false` | When `true`, the SOUL text becomes the complete system prompt after assembly. Use only for deliberately minimal presets. |
| `tools` | `true` | Set `false` to keep only the static persona injection (v0.1 behavior) without the maintenance tools. |

### Global persona (default)

```yaml
- id: dsh-soul
  name: 'dsh-soul'
  config:
    maxBytes: 65536
```

### Explicit file

```yaml
- id: dsh-soul
  name: 'dsh-soul'
  config:
    maxBytes: 65536
    file: D:\personas\neptune\SOUL.md
```

### Per-preset shadow

If `dsh-soul` is mounted from an `agent.cordis.yml` preset scope, it may
shadow that preset's deployment persona:

```yaml
- id: soul
  name: 'dsh-soul'
  config:
    maxBytes: 65536
    sectionName: deployment:persona
    order: 0
```

In a host profile patch, `sectionName: deployment:persona` would collide with
the system prompt registry's own global persona registration and fail loud;
leave it as `soul:persona` there.

## Semantics

- **Refresh.** The file is read once at mount and again at every
  `agent/session-start`; the registered section is replaced only when the
  text changed. Within a session the soul stays stable, matching the stable
  persona model of `@deepseek-ai/dsh-persona`. Deleting the file removes the
  section on the next session start.
- **Writes.** Maintenance tools go through the host `fs` provider: they ask
  the `fs/write-intent` slot for a version guard (so a stale write after an
  external edit is detected), write atomically under the calling session's
  sandbox policy, and record `fs/observed` like the built-in file tools.
  Under a confining profile, point `file` inside your workspace or use a
  session policy that permits the path. Without a mounted `fs` provider the
  persona section still works (Node fallback), but the tools are skipped.
- **Interpolation.** The raw text becomes a system-prompt section, so the
  system-prompt registry still interpolates complete `{{...}}` groups against
  registered variables. Avoid `{{model}}`-shaped prose in `SOUL.md` unless you
  intend that variable reference.
- **Growth discipline.** `soul_remember` keeps entries to one dated line;
  when the file approaches `maxBytes`, rewrite it more compactly with
  `soul_rewrite` (or raise `maxBytes` and reload). Memory entries land under
  `## ` sections when one is named, otherwise at the end of the file.

## Test

```sh
node --test
```

## Trust

`SOUL.md` is user-authored prompt injection by design. Point `file` only at
files you own and keep the loaded size bounded. The `/soul` routes are served
on the same host/port as the Web UI with no additional auth and mutate only
the single configured file — the same boundary as the shipped settings pages,
so keep the deployment on loopback hosts.
