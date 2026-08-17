// dsh-soul — Client half (hand-written web plugin bundle).
//
// Renders one collapse/expand "SOUL.md" card inside the Plugins settings
// configuration section (the `settings.plugin.item` slot, where the shipped
// bash / agent-loop / web-search cards live). The collapsed header is a
// horizontal bar with the soul's byte status; expanding it opens the full
// editor over the same-origin /soul JSON API served by the host half, with
// the same maxBytes budget the tools enforce. The only module dependency is
// react, a platform seed word.
window.__ModuleLoader__.load({
	id: "dsh-soul",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		function el(type, props, ...children) {
			return React.createElement(type, props, ...children);
		}

		function errText(e) {
			if (e == null) return "unknown error";
			if (typeof e === "object" && e.message != null) return String(e.message);
			return String(e);
		}

		async function api(path, body) {
			const res = await fetch("/soul" + path, body === undefined
				? { method: "GET" }
				: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			const text = await res.text();
			let data = null;
			try { data = text ? JSON.parse(text) : null; } catch { data = null; }
			if (!res.ok) {
				throw new Error((data && data.error) || "HTTP " + res.status);
			}
			return data;
		}

		const S = {
			card: { border: "1px solid var(--color-border, #e5e5e5)", borderRadius: 8, overflow: "hidden", background: "var(--color-bg, transparent)" },
			header: { display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", background: "transparent", border: "none", cursor: "pointer", fontSize: 13, color: "var(--color-text, inherit)", textAlign: "left" },
			headText: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
			name: { fontWeight: 600 },
			description: { fontSize: 12, color: "var(--color-text-secondary, #888)" },
			status: { marginLeft: "auto", fontSize: 11, color: "var(--color-text-secondary, #888)", whiteSpace: "nowrap" },
			statusDirty: { marginLeft: "auto", fontSize: 11, color: "#2563eb", whiteSpace: "nowrap" },
			chevron: { fontSize: 10, color: "var(--color-text-secondary, #888)", flexShrink: 0 },
			body: { display: "flex", flexDirection: "column", gap: 8, padding: "0 12px 12px", borderTop: "1px solid var(--color-border, #eee)" },
			row: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" },
			btn: { padding: "5px 10px", border: "1px solid var(--color-border, #ccc)", borderRadius: 6, background: "transparent", fontSize: 12, cursor: "pointer", color: "var(--color-text, inherit)" },
			btnPrimary: { padding: "5px 10px", border: "1px solid #2563eb", borderRadius: 6, background: "#2563eb", fontSize: 12, cursor: "pointer", color: "#fff" },
			textArea: { width: "100%", minHeight: 240, fontFamily: "monospace", fontSize: 12, padding: 8, border: "1px solid var(--color-border, #ccc)", borderRadius: 6, boxSizing: "border-box", background: "var(--color-bg-subtle, rgba(0,0,0,.03))", color: "var(--color-text, inherit)", resize: "vertical" },
			counter: { fontSize: 12, color: "var(--color-text-secondary, #888)" },
			counterOver: { fontSize: 12, color: "#dc2626", fontWeight: 600 },
			error: { color: "#dc2626", fontSize: 12 },
			note: { fontSize: 12, color: "var(--color-text-secondary, #888)" },
			path: { fontSize: 11, color: "var(--color-text-secondary, #888)", wordBreak: "break-all", fontFamily: "monospace" },
			disabledBtn: { opacity: 0.45, cursor: "not-allowed" },
		};

		function SoulCard() {
			const [open, setOpen] = React.useState(false);
			const [meta, setMeta] = React.useState(null); // {exists, bytes, maxBytes, file} | null
			const [editing, setEditing] = React.useState("");
			const [loadedText, setLoadedText] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [saving, setSaving] = React.useState(false);
			const [error, setError] = React.useState(null);
			const [savedMsg, setSavedMsg] = React.useState(null);

			async function load() {
				setBusy(true);
				setError(null);
				try {
					const data = await api("");
					setMeta({ exists: data.exists, bytes: data.bytes, maxBytes: data.maxBytes, file: data.file });
					setEditing(data.text);
					setLoadedText(data.text);
					setSavedMsg(null);
				} catch (e) {
					setError(errText(e));
				} finally {
					setBusy(false);
				}
			}

			React.useEffect(() => { load(); }, []);

			const dirty = editing !== loadedText;
			const bytes = new TextEncoder().encode(editing).length;
			const over = meta !== null && bytes > meta.maxBytes;

			async function save() {
				if (over) { setError("内容超过 maxBytes=" + meta.maxBytes + "，请精简后再保存"); return; }
				setSaving(true);
				setError(null);
				setSavedMsg(null);
				try {
					await api("/save", { content: editing });
					await load();
					setSavedMsg("已保存。当前会话保持启动时的灵魂，新会话开始即生效。");
				} catch (e) {
					setError(errText(e));
				} finally {
					setSaving(false);
				}
			}

			const statusText = meta === null
				? (busy ? "加载中…" : "")
				: (over ? "超限 " + bytes + " / " + meta.maxBytes : bytes + " / " + meta.maxBytes + " 字节");

			return el("li", { style: S.card },
				el("button", {
					type: "button",
					style: S.header,
					"aria-expanded": open,
					onClick: () => setOpen(!open),
				},
					el("span", { style: S.headText },
						el("span", { style: S.name }, "SOUL.md"),
						el("span", { style: S.description }, meta === null || !meta.exists ? "跨会话灵魂文件（尚未创建，保存后创建）" : "跨会话灵魂文件，注入每次模型请求的系统提示"),
					),
					dirty ? el("span", { style: S.statusDirty }, "未保存") : null,
					el("span", { style: S.status }, statusText),
					el("span", { style: S.chevron }, open ? "▼" : "▶"),
				),
				open ? el("div", { style: S.body },
					error ? el("div", { style: S.error }, error) : null,
					savedMsg ? el("div", { style: S.note }, savedMsg) : null,
					el("textarea", {
						style: S.textArea,
						value: editing,
						spellCheck: false,
						placeholder: busy ? "加载中…" : "# SOUL.md\n\n## Identity\n- …",
						onChange: (e) => setEditing(e.target.value),
					}),
					el("div", { style: S.row },
						el("span", { style: over ? S.counterOver : S.counter }, bytes + " / " + (meta ? meta.maxBytes : "?") + " 字节" + (over ? "（超限，无法保存）" : "")),
						el("button", {
							style: { ...S.btnPrimary, ...(saving || !dirty || over || busy ? S.disabledBtn : {}) },
							disabled: saving || !dirty || over || busy,
							onClick: save,
						}, saving ? "保存中…" : "保存"),
						el("button", {
							style: { ...S.btn, ...(!dirty || busy ? S.disabledBtn : {}) },
							disabled: !dirty || busy,
							onClick: () => setEditing(loadedText),
						}, "撤销"),
						el("button", { style: S.btn, onClick: load, disabled: busy }, "刷新"),
					),
					meta && meta.file ? el("div", { style: S.path }, meta.file) : null,
					el("div", { style: S.note }, "文件在每次会话开始时重新读取并注入；也可以用 soul_remember / soul_edit / soul_rewrite 工具让 agent 自己维护。"),
				) : null,
			);
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			slots.inject("settings.plugin.item", () => slots.register(
				{ name: "settings.plugin.item", id: "soul", order: 30 },
				() => el(SoulCard),
			));
		}

		exports.apply = apply;
		return module.exports;
	}
});
