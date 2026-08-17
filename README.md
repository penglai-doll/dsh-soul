# dsh-soul

[![GitHub topics: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-7c3aed)](https://github.com/topics/dsh-plugin)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> Bilingual 中英双语：English first, 中文译文在后。

## English

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

---

## 中文

DeepSeek Harness 的基于文件的 **活体灵魂（living soul）**：OpenClaw / Hermes 的 `SOUL.md` 效果，拆成这两个系统实际拥有的两半。

1. **持久人设。** 一个可信的 `SOUL.md` 风格 markdown 文件被注册为一个有序 system-prompt section。该 section 在每次模型请求时组装、永不被压缩掉，并在每个会话开始时重新读取——改文件后下一个会话即生效，无需重启进程。
2. **由 agent 维护的记忆。** 四个工具让 agent 跨会话演化自己的灵魂，类似 OpenClaw 的 soul maintenance：

| 工具 | 用途 |
|---|---|
| `soul_view` | 读取当前 SOUL.md 内容（附字节占用）。 |
| `soul_remember` | 追加一条带日期的持久事实/偏好/记忆行，可选归档到某个 `## ` 小节下。 |
| `soul_edit` | 把 `oldText` 的一次字面出现替换为 `newText`。 |
| `soul_rewrite` | 整体重写文件——创建、精简、重构。 |

一个 `tool:soul` system-prompt section 告诉 agent 何时用哪个工具。

3. **管理 UI。** 当部署挂载了 `webServer`（Web profile）时，插件配置区（设置 → 插件 → 插件配置）会出现一张可折叠/展开的 **SOUL.md** 卡片，与随附的 bash / agent-loop / web-search 卡片并列。折叠横条显示灵魂的字节状态与"未保存"标记；展开后是一个 textarea 编辑器，带保存 / 撤销 / 重载，走与 Web UI 同源同端口的同源 JSON API。

## Web UI 与 API

卡片位于插件配置区（`settings.plugin.item`，id `soul`，order 30）。Host 半边提供：

| 路由 | 用途 |
|---|---|
| `GET /soul` | 当前灵魂：`{ ok, exists, text, bytes, maxBytes, file }`。文件不存在时报告 `exists: false`。 |
| `POST /soul/save` | 用 `{ content }` 整体替换灵魂。强制 `maxBytes` 并拒绝空白内容；不存在时创建文件。 |

草稿超过 `maxBytes` 时编辑器告警、API 拒绝写入，因此字节预算对每一条会变更灵魂的路径（工具与 UI）都成立。保存不会热替换运行中会话的 section——当前会话保留它启动时的灵魂，下一个会话启动才取新内容。

## 它不做什么

- 绝不**发现**任意项目目录里的 `SOUL.md` 文件：克隆下来的仓库绝不能更改 agent 的人设。按设计，把配置路径视为可信的 prompt injection。
- 绝不写入单个配置文件之外的任何路径，且每次写入都遵守 `maxBytes` 预算。超限写入被拒绝并提示精简。
- 缺失、非文件、超限、不可读的输入绝不会破坏 profile：人设 section 直接缺席（或瞬态读错误时保留旧灵魂），工具以清晰消息失败。

## 安装

```sh
dsh plugin --profile web add <this-directory>
```

然后向 profile 的 `cordis.patch.yml` 加一行：

```yaml
- insert:
    - id: dsh-soul
      name: 'dsh-soul'
      config:
        maxBytes: 65536
```

重启 `dsh web`。`maxBytes` 必填，因为该文本会在每次模型请求的系统提示里重复。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxBytes` | 必填 | SOUL 文件的最大 UTF-8 字节数。超过此限的读写被拒绝。 |
| `file` | `$DSH_HOME/SOUL.md` | 要加载与维护的文件。`~`、`~/`、`~\` 前缀会展开；相对路径从 `process.cwd()` 解析。 |
| `dshHome` | `$DSH_HOME`，否则 `~/.dsh` | 覆盖默认 `file` 路径使用的 harness home。 |
| `sectionName` | `soul:persona` | system-prompt section 名。仅在行挂载于 agent preset scope（会遮蔽部署人设）时用 `deployment:persona`。 |
| `order` | `1` | system-prompt section 顺序。`-100` 是 harness 身份，`0` 是部署人设，工具指引约从 `100` 开始。 |
| `complete` | `false` | 为 `true` 时，SOUL 文本在组装后成为完整系统提示。仅用于刻意极简的预设。 |
| `tools` | `true` | 设 `false` 则只保留静态人设注入（v0.1 行为），不带维护工具。 |

### 全局人设（默认）

```yaml
- id: dsh-soul
  name: 'dsh-soul'
  config:
    maxBytes: 65536
```

### 显式文件

```yaml
- id: dsh-soul
  name: 'dsh-soul'
  config:
    maxBytes: 65536
    file: D:\personas\neptune\SOUL.md
```

### 逐预设遮蔽

若 `dsh-soul` 从某个 `agent.cordis.yml` 预设 scope 挂载，它可以遮蔽该预设的部署人设：

```yaml
- id: soul
  name: 'dsh-soul'
  config:
    maxBytes: 65536
    sectionName: deployment:persona
    order: 0
```

在 host profile 补丁里，`sectionName: deployment:persona` 会与 system-prompt 注册表自身的全局人设注册冲突并响亮失败；那里请保留 `soul:persona`。

## 语义

- **刷新。** 文件在挂载时读一次、每次 `agent/session-start` 再读一次；仅当文本变化时才替换已注册 section。会话内灵魂保持稳定，与 `@deepseek-ai/dsh-persona` 的稳定人设模型一致。删除文件会在下一个会话开始时移除 section。
- **写入。** 维护工具走 host `fs` provider：向 `fs/write-intent` 槽请求版本 guard（从而检测外部编辑后的过期写入）、在调用会话的沙箱策略下原子写入、并像内置文件工具一样记录 `fs/observed`。在受限 profile 下，把 `file` 指向你的工作区内，或用允许该路径的会话策略。未挂载 `fs` provider 时人设 section 仍可用（Node 回退），但工具被跳过。
- **插值。** 原文成为 system-prompt section，因此 system-prompt 注册表仍会把完整的 `{{...}}` 组对注册变量做插值。除非你确实要引用该变量，否则避免在 `SOUL.md` 里写 `{{model}}` 形状的文本。
- **增长纪律。** `soul_remember` 让条目保持单行带日期；文件逼近 `maxBytes` 时用 `soul_rewrite` 精简重写（或调大 `maxBytes` 后重载）。命名了 `## ` 小节时记忆条目落到该小节下，否则追加到文件末尾。

## 测试

```sh
node --test
```

## 信任

`SOUL.md` 按设计就是用户撰写的 prompt injection。只把 `file` 指向你拥有的文件，并保持加载体积有界。`/soul` 路由与 Web UI 同源同端口、无额外鉴权，且只变更那一个配置文件——与随附设置页的边界相同，因此请把部署保持在 loopback 主机上。
