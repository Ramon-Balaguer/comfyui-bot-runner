import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const STRINGS = {
  en: {
    title: "Bot Runner",
    tooltip: "Bot Runner: keep a workflow running on the server",
    running: "Running",
    stopped: "Stopped",
    working: "generating",
    waiting: "waiting for the next run",
    enabled: "Keep the workflow running",
    workflow: "Workflow",
    none: "No workflow captured yet",
    captured: "captured",
    nodes: "nodes",
    capture: "Use current workflow",
    captureHint: "Captures the open workflow exactly as the Queue button would send it. Open your bot workflow and press it again whenever you change it.",
    seeds: "Randomize seeds on every run",
    idle: "Free VRAM after (min) without generating",
    idleHint: "0 = never. Lets other GPU apps (e.g. llama.cpp) use the memory while the bot is idle.",
    freeNow: "Free VRAM now",
    stats: "Activity",
    runs: "Runs",
    generations: "Generations",
    lastGen: "Last generation",
    freedAt: "VRAM freed",
    lastError: "Last error",
    never: "never",
    warnInstant: "Don't use \"Run (Instant)\" in the browser at the same time: the server already re-queues the workflow.",
    confirmReplace: "The runner is enabled. Replace the running workflow with the current one?",
    capturedOk: "Workflow captured",
    error: "Error",
  },
  es: {
    title: "Bot Runner",
    tooltip: "Bot Runner: mantener un workflow ejecutándose en el servidor",
    running: "En marcha",
    stopped: "Parado",
    working: "generando",
    waiting: "esperando la siguiente vuelta",
    enabled: "Mantener el workflow en marcha",
    workflow: "Workflow",
    none: "Todavía no hay ningún workflow capturado",
    captured: "capturado",
    nodes: "nodos",
    capture: "Usar el workflow actual",
    captureHint: "Captura el workflow abierto tal y como lo enviaría el botón Queue. Abre tu workflow del bot y vuelve a pulsarlo cada vez que lo cambies.",
    seeds: "Semillas aleatorias en cada vuelta",
    idle: "Liberar VRAM tras (min) sin generar",
    idleHint: "0 = nunca. Deja la memoria a otras apps de GPU (p. ej. llama.cpp) mientras el bot está ocioso.",
    freeNow: "Liberar VRAM ahora",
    stats: "Actividad",
    runs: "Vueltas",
    generations: "Generaciones",
    lastGen: "Última generación",
    freedAt: "VRAM liberada",
    lastError: "Último error",
    never: "nunca",
    warnInstant: "No uses \"Run (Instant)\" en el navegador a la vez: el servidor ya relanza el workflow.",
    confirmReplace: "El runner está encendido. ¿Sustituir el workflow en marcha por el actual?",
    capturedOk: "Workflow capturado",
    error: "Error",
  },
};
const T = STRINGS[(navigator.language || "en").toLowerCase().startsWith("es") ? "es" : "en"];

const CSS = `
.br-root{padding:12px;display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--fg-color);}
.br-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.br-head h3{margin:0;font-size:16px}
.br-pill{border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;white-space:nowrap}
.br-on{background:#1f7a3f;color:#fff}.br-off{background:var(--comfy-input-bg);color:var(--descrip-text,#999)}
.br-card{border:1px solid var(--border-color);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px;background:var(--comfy-menu-bg)}
.br-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.br-muted{color:var(--descrip-text,#999);font-size:12px;line-height:1.35}
.br-btn{cursor:pointer;border:1px solid var(--border-color);background:var(--comfy-input-bg);color:var(--fg-color);border-radius:6px;padding:6px 10px;font-size:13px}
.br-btn:hover{filter:brightness(1.2)}
.br-primary{background:var(--p-primary-color,#3b82f6);border-color:transparent;color:var(--p-primary-contrast-color,#fff)}
.br-input{width:64px;background:var(--comfy-input-bg);color:var(--fg-color);border:1px solid var(--border-color);border-radius:6px;padding:4px 6px}
.br-switch{position:relative;width:40px;height:22px;flex:none}
.br-switch input{opacity:0;width:0;height:0}
.br-slider{position:absolute;inset:0;border-radius:22px;background:var(--comfy-input-bg);border:1px solid var(--border-color);cursor:pointer;transition:.2s}
.br-slider:before{content:"";position:absolute;width:16px;height:16px;left:2px;top:2px;border-radius:50%;background:var(--fg-color);transition:.2s}
.br-switch input:checked+.br-slider{background:#1f7a3f}
.br-switch input:checked+.br-slider:before{transform:translateX(18px);background:#fff}
.br-stats{display:grid;grid-template-columns:auto 1fr;gap:4px 12px}
.br-stats span:nth-child(odd){color:var(--descrip-text,#999)}
.br-err{color:#f87171;word-break:break-word}
.br-wf{font-weight:600;word-break:break-all}
`;

function fmtTime(ts) {
  if (!ts) return T.never;
  const d = new Date(ts * 1000);
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)} min`;
  return d.toLocaleString();
}

async function callApi(path, body) {
  const res = await api.fetchApi(path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(severity, detail) {
  const t = app.extensionManager?.toast;
  if (t) t.add({ severity, summary: T.title, detail, life: 4000 });
  else if (severity === "error") alert(detail);
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(c);
  return n;
}

function renderPanel(container) {
  if (!document.getElementById("br-style")) {
    document.head.append(el("style", { id: "br-style" }, CSS));
  }
  container.innerHTML = "";

  const pill = el("span", { class: "br-pill br-off" }, T.stopped);
  const enabled = el("input", { type: "checkbox" });
  const wfName = el("div", { class: "br-wf" });
  const wfMeta = el("div", { class: "br-muted" });
  const seeds = el("input", { type: "checkbox" });
  const idle = el("input", { type: "number", min: "0", step: "1", class: "br-input" });
  const stats = el("div", { class: "br-stats" });
  const err = el("div", { class: "br-err" });
  let status = null;

  enabled.addEventListener("change", async () => {
    try { update(await callApi("/bot-runner/config", { enabled: enabled.checked })); }
    catch (e) { enabled.checked = false; toast("error", e.message); }
  });
  seeds.addEventListener("change", async () => {
    try { update(await callApi("/bot-runner/config", { randomize_seeds: seeds.checked })); }
    catch (e) { toast("error", e.message); }
  });
  idle.addEventListener("change", async () => {
    try { update(await callApi("/bot-runner/config", { idle_free_minutes: Number(idle.value) })); }
    catch (e) { toast("error", e.message); }
  });

  const captureBtn = el("button", {
    class: "br-btn br-primary",
    onclick: async () => {
      if (status?.enabled && status?.has_prompt && !confirm(T.confirmReplace)) return;
      try {
        const p = await app.graphToPrompt();
        const name = app.extensionManager?.workflow?.activeWorkflow?.filename || "workflow";
        update(await callApi("/bot-runner/capture", { name, prompt: p.output, workflow: p.workflow }));
        toast("success", `${T.capturedOk}: ${name}`);
      } catch (e) { toast("error", e.message); }
    },
  }, T.capture);
  const freeBtn = el("button", {
    class: "br-btn",
    onclick: async () => {
      try { update(await callApi("/bot-runner/free", {})); } catch (e) { toast("error", e.message); }
    },
  }, T.freeNow);

  container.append(el("div", { class: "br-root" },
    el("div", { class: "br-head" }, el("h3", {}, T.title), pill),
    el("div", { class: "br-card" },
      el("div", { class: "br-row" }, el("span", {}, T.enabled),
        el("label", { class: "br-switch" }, enabled, el("span", { class: "br-slider" }))),
      el("div", { class: "br-muted" }, T.warnInstant)),
    el("div", { class: "br-card" },
      el("div", { class: "br-muted" }, T.workflow), wfName, wfMeta, captureBtn,
      el("div", { class: "br-muted" }, T.captureHint)),
    el("div", { class: "br-card" },
      el("div", { class: "br-row" }, el("span", {}, T.seeds), seeds),
      el("div", { class: "br-row" }, el("span", {}, T.idle), idle),
      el("div", { class: "br-muted" }, T.idleHint), freeBtn),
    el("div", { class: "br-card" }, el("div", { class: "br-muted" }, T.stats), stats, err)));

  function update(s) {
    status = s;
    const on = s.enabled;
    pill.className = `br-pill ${on ? "br-on" : "br-off"}`;
    pill.textContent = on ? `${T.running} · ${s.busy && s.current_generated ? T.working : T.waiting}` : T.stopped;
    enabled.checked = on;
    wfName.textContent = s.has_prompt ? s.workflow_name : T.none;
    wfMeta.textContent = s.has_prompt ? `${T.captured} ${fmtTime(s.captured_at)} · ${s.node_count} ${T.nodes}` : "";
    seeds.checked = s.randomize_seeds;
    if (document.activeElement !== idle) idle.value = s.idle_free_minutes;
    stats.replaceChildren(
      el("span", {}, T.runs), el("span", {}, String(s.runs)),
      el("span", {}, T.generations), el("span", {}, String(s.generations)),
      el("span", {}, T.lastGen), el("span", {}, fmtTime(s.last_generation)),
      el("span", {}, T.freedAt), el("span", {}, fmtTime(s.vram_freed_at)));
    err.textContent = s.last_error ? `${T.lastError} (${fmtTime(s.last_error.time)}): ${s.last_error.message}` : "";
  }

  const refresh = async () => {
    try { update(await callApi("/bot-runner/status")); } catch (e) { /* server restarting */ }
  };
  refresh();
  const timer = setInterval(() => {
    if (!container.isConnected) return clearInterval(timer);
    refresh();
  }, 2000);
}

app.registerExtension({
  name: "Comfy.BotRunner",
  async setup() {
    app.extensionManager.registerSidebarTab({
      id: "bot-runner",
      icon: "pi pi-send",
      title: T.title,
      tooltip: T.tooltip,
      type: "custom",
      render: renderPanel,
    });
  },
});
