// Read-only Ansicht: holt Dashboard-Modell, Live-Werte, Markdown-Texte und Diagrammdaten
// nur vom Portal-Server. Bibliotheken kommen lokal vom Portal (/vendor), nicht aus einem CDN.
import { Marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";
import { renderMarkdown, ICON_NAME } from "/markdown.js";
import { applyIcons } from "/icons.js";
import { chartOptions, appendLive } from "/charts.js";

const $ = (s) => document.querySelector(s);
const states = {};
const templates = {}; // Karten-ID → { text } | { error }
const graphs = new Map(); // Karten-ID → { card, el, data, charts: Map(key → { div, inst }) }
let dashboards = [];
let dashboard = null;
let dashboardId = null;
let viewIndex = 0;
let events = null;
let reconnectTimer = null;
let statsTimer = null;

const resizer = new ResizeObserver((entries) => {
  for (const e of entries) e.target._chart?.resize();
});

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function friendly(ref) {
  const s = states[ref.entity];
  return ref.name ?? s?.attributes?.friendly_name ?? ref.entity;
}

// Zustände wie in der deutschen HA-Oberfläche
const STATE_DE = {
  on: "An", off: "Aus", open: "Offen", closed: "Geschlossen", opening: "Öffnet", closing: "Schließt",
  locked: "Verriegelt", unlocked: "Entriegelt", locking: "Verriegelt …", unlocking: "Entriegelt …", jammed: "Blockiert",
  home: "Zuhause", not_home: "Abwesend", unavailable: "Nicht verfügbar", unknown: "Unbekannt",
  playing: "Spielt", paused: "Pausiert", idle: "Untätig", standby: "Standby",
  heat: "Heizen", cool: "Kühlen", auto: "Automatisch", heat_cool: "Heizen/Kühlen", dry: "Entfeuchten", fan_only: "Nur Lüfter",
  above_horizon: "Über dem Horizont", below_horizon: "Unter dem Horizont",
};
const DATE_FMT = new Intl.DateTimeFormat("de-AT", { dateStyle: "medium", timeStyle: "short" });

function formatState(entity) {
  const s = states[entity];
  if (!s) return "–";
  const a = s.attributes ?? {};
  if (s.state === "unavailable" || s.state === "unknown") return STATE_DE[s.state];
  if (entity.startsWith("climate.")) {
    return `${a.current_temperature ?? "–"} °C (Soll ${a.temperature ?? "–"})`;
  }
  if (a.device_class === "timestamp") {
    const d = new Date(s.state);
    if (!Number.isNaN(d.getTime())) return DATE_FMT.format(d);
  }
  if (entity.startsWith("cover.") && s.state === "open" && typeof a.current_position === "number" && a.current_position < 100) {
    return `Offen · ${a.current_position} %`;
  }
  if (a.unit_of_measurement) return `${s.state} ${a.unit_of_measurement}`;
  return STATE_DE[s.state] ?? s.state;
}

function stateClass(entity) {
  const v = states[entity]?.state;
  if (v === "on" || v === "open" || v === "home") return "on";
  if (v === "unavailable") return "unavailable";
  return "";
}

// Standard-Icons je Gerätetyp – nur für Kacheln (wie in HA), Zeilen bleiben ohne
const DOMAIN_ICON = {
  cover: ["mdi:window-shutter", "mdi:window-shutter-open"],
  light: ["mdi:lightbulb-outline", "mdi:lightbulb"],
  switch: ["mdi:toggle-switch-variant-off", "mdi:toggle-switch-variant"],
  input_boolean: ["mdi:toggle-switch-variant-off", "mdi:toggle-switch-variant"],
  fan: ["mdi:fan-off", "mdi:fan"],
  lock: ["mdi:lock-open-variant", "mdi:lock"],
  climate: ["mdi:thermostat", "mdi:thermostat"],
  media_player: ["mdi:cast", "mdi:cast-connected"],
  person: ["mdi:account", "mdi:account"],
  binary_sensor: ["mdi:checkbox-blank-circle-outline", "mdi:checkbox-marked-circle"],
  sensor: ["mdi:eye", "mdi:eye"],
  select: ["mdi:format-list-bulleted", "mdi:format-list-bulleted"],
  input_select: ["mdi:format-list-bulleted", "mdi:format-list-bulleted"],
  scene: ["mdi:palette", "mdi:palette"],
  script: ["mdi:script-text", "mdi:script-text-play"],
  automation: ["mdi:robot-off", "mdi:robot"],
  sun: ["mdi:weather-sunny", "mdi:weather-sunny"],
  weather: ["mdi:weather-partly-cloudy", "mdi:weather-partly-cloudy"],
};
const ACTIVE = new Set(["on", "open", "opening", "closing", "locked", "home", "playing", "heat", "cool", "auto"]);

/** Icon: aus der Kartenkonfiguration, sonst attributes.icon der Entität (bei Kacheln sonst Gerätetyp). */
function iconFor(ref) {
  if (ref.icon) return ref.icon;
  const a = states[ref.entity]?.attributes?.icon;
  if (typeof a === "string" && ICON_NAME.test(a)) return a;
  if (ref.domainIcon) {
    const pair = DOMAIN_ICON[ref.entity.split(".")[0]];
    if (pair) return pair[ACTIVE.has(states[ref.entity]?.state) ? 1 : 0];
  }
  return "";
}

function iconEl(ref) {
  const el = h("span", "icon");
  el.dataset.iconOf = JSON.stringify(ref);
  el.dataset.icon = iconFor(ref);
  return el;
}

function nameEl(tag, cls, ref) {
  const el = h(tag, cls, friendly(ref));
  el.dataset.nameOf = JSON.stringify(ref);
  return el;
}

function row(ref) {
  const r = h("div", "row");
  const label = h("span", "label");
  label.append(iconEl(ref), nameEl("span", "name", ref));
  r.append(label);
  const v = h("span", "val " + stateClass(ref.entity), formatState(ref.entity));
  v.dataset.entity = ref.entity;
  r.append(v);
  return r;
}

function renderMarkdownInto(el, id) {
  const t = templates[id];
  el.classList.toggle("error", !!t?.error);
  if (!t) {
    el.replaceChildren(h("span", "muted", "…"));
  } else if (t.error) {
    el.replaceChildren(h("span", "", `Template-Fehler: ${t.error}`));
  } else {
    el.replaceChildren(renderMarkdown(t.text, Marked, DOMPurify));
    applyIcons(el);
  }
}

function renderCard(c) {
  switch (c.kind) {
    case "heading":
      return h("div", "heading", c.text);
    case "entities": {
      const el = h("div", "card");
      if (c.title) el.append(h("h3", "", c.title));
      c.entities.forEach((e) => el.append(row(e)));
      return el;
    }
    case "graph": {
      const el = h("div", "card graph-card");
      if (c.title) el.append(h("h3", "", c.title));
      const body = h("div", "graph");
      body.append(h("span", "muted", "Diagramm wird geladen …"));
      el.append(body);
      graphs.set(c.id, { card: c, el: body, data: null, charts: new Map() });
      return el;
    }
    case "markdown": {
      const el = h("div", "card");
      if (c.title) el.append(h("h3", "", c.title));
      const body = h("div", "markdown");
      body.dataset.md = c.id;
      renderMarkdownInto(body, c.id);
      el.append(body);
      return el;
    }
    case "glance": {
      const el = h("div", "card");
      if (c.title) el.append(h("h3", "", c.title));
      const g = h("div", "glance");
      for (const e of c.entities) {
        const cell = h("div");
        cell.append(iconEl(e), nameEl("div", "name", e));
        const v = h("div", "val " + stateClass(e.entity), formatState(e.entity));
        v.dataset.entity = e.entity;
        cell.append(v);
        g.append(cell);
      }
      el.append(g);
      return el;
    }
    case "single": {
      if (c.type === "tile") {
        // kompakt wie die HA-Kachel: Icon im Kreis, daneben Name und Zustand
        const el = h("div", "card tile");
        const ref = { ...c.entity, domainIcon: true };
        const bubble = h("span", "tile-icon " + stateClass(c.entity.entity));
        bubble.dataset.stateOf = c.entity.entity;
        bubble.append(iconEl(ref));
        const text = h("div", "tile-text");
        text.append(nameEl("div", "tile-name", c.entity));
        const v = h("div", "tile-state val " + stateClass(c.entity.entity), formatState(c.entity.entity));
        v.dataset.entity = c.entity.entity;
        text.append(v);
        el.append(bubble, text);
        return el;
      }
      const el = h("div", "card");
      const head = h("h3", "with-icon");
      head.append(iconEl(c.entity), nameEl("span", "", c.entity));
      el.append(head);
      const v = h("div", "big val " + stateClass(c.entity.entity), formatState(c.entity.entity));
      v.dataset.entity = c.entity.entity;
      el.append(v);
      if (c.type === "gauge") {
        const bar = h("div", "bar");
        const fill = h("div");
        fill.dataset.gauge = JSON.stringify({ entity: c.entity.entity, min: c.min ?? 0, max: c.max ?? 100 });
        bar.append(fill);
        el.append(bar);
      }
      return el;
    }
    case "stack": {
      const wrap = h("div", "card");
      if (c.title) wrap.append(h("h3", "", c.title));
      const s = h("div", "stack " + c.direction);
      c.cards.forEach((x) => s.append(renderCard(x)));
      wrap.append(s);
      return wrap;
    }
    default:
      return h("div", "card unsupported", c.type);
  }
}

function updateValues() {
  document.querySelectorAll("[data-entity]").forEach((el) => {
    const e = el.dataset.entity;
    el.textContent = formatState(e);
    el.classList.remove("on", "unavailable");
    const cls = stateClass(e);
    if (cls) el.classList.add(cls);
  });
  document.querySelectorAll("[data-name-of]").forEach((el) => {
    el.textContent = friendly(JSON.parse(el.dataset.nameOf));
  });
  document.querySelectorAll("[data-state-of]").forEach((el) => {
    el.classList.remove("on", "unavailable");
    const cls = stateClass(el.dataset.stateOf);
    if (cls) el.classList.add(cls);
  });
  document.querySelectorAll("[data-icon-of]").forEach((el) => {
    el.dataset.icon = iconFor(JSON.parse(el.dataset.iconOf));
  });
  applyIcons();
  document.querySelectorAll("[data-gauge]").forEach((el) => {
    const g = JSON.parse(el.dataset.gauge);
    const v = Number(states[g.entity]?.state);
    const pct = Number.isFinite(v) ? Math.max(0, Math.min(100, ((v - g.min) / (g.max - g.min)) * 100)) : 0;
    el.style.width = pct + "%";
  });
}

// ---------- Diagramme ----------

function drawGraph(g) {
  const specs = chartOptions(g.data);
  if (specs.length === 0) {
    disposeCharts(g);
    g.el.replaceChildren(h("span", "muted", "Keine Daten im Zeitraum"));
    return;
  }
  const keep = new Set(specs.map((s) => s.key));
  for (const [key, c] of g.charts) {
    if (!keep.has(key)) {
      resizer.unobserve(c.div);
      c.inst.dispose();
      c.div.remove();
      g.charts.delete(key);
    }
  }
  if (g.charts.size === 0) g.el.replaceChildren();
  for (const spec of specs) {
    let c = g.charts.get(spec.key);
    if (!c) {
      const div = h("div", "chart");
      div.style.height = spec.height + "px";
      g.el.append(div);
      const inst = window.echarts.init(div, null, { renderer: "canvas" });
      div._chart = inst;
      resizer.observe(div);
      c = { div, inst };
      g.charts.set(spec.key, c);
    }
    c.div.style.height = spec.height + "px";
    c.inst.setOption(spec.option, { notMerge: true });
    c.inst.resize();
  }
}

function disposeCharts(g) {
  for (const c of g.charts.values()) {
    resizer.unobserve(c.div);
    c.inst.dispose();
  }
  g.charts.clear();
}

async function loadGraph(id) {
  const g = graphs.get(id);
  if (!g) return;
  try {
    const res = await fetch(`/api/dashboards/${encodeURIComponent(dashboardId)}/graphs/${encodeURIComponent(id)}`);
    const data = await res.json();
    if (graphs.get(id) !== g) return; // inzwischen neu gezeichnet
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    g.data = data;
    drawGraph(g);
  } catch (e) {
    if (graphs.get(id) !== g) return;
    disposeCharts(g);
    g.el.replaceChildren(h("span", "muted", `Diagramm nicht verfügbar: ${e.message}`));
  }
}

function loadAllGraphs(kind) {
  for (const [id, g] of graphs) if (!kind || g.data?.kind === kind || !g.data) loadGraph(id);
}

function clearGraphs() {
  for (const g of graphs.values()) disposeCharts(g);
  graphs.clear();
}

function liveGraphs(entity, state) {
  for (const g of graphs.values()) {
    if (g.data && appendLive(g.data, entity, state)) drawGraph(g);
  }
}

// ---------- Ansicht, Dashboard, Live-Verbindung ----------

function renderView() {
  clearGraphs();
  const container = $("#cards");
  container.replaceChildren();
  const view = dashboard?.views[viewIndex];
  // Titel und Navigation immer nachziehen – auch wenn es nichts zu zeigen gibt
  $("#viewTitle").textContent = view && dashboard.views.length > 1 ? view.title : "";
  renderNav();
  if (!view || (view.cards.length === 0 && view.strategy)) {
    const strategy = view?.strategy ?? dashboard?.strategy;
    const was = view?.strategy ? "Diese Ansicht" : "Dieses Dashboard";
    const msg = strategy
      ? `${was} erzeugt Home Assistant automatisch („${strategy}“). Der Home Assistant Reader free zeigt nur Dashboards mit fest eingerichteten Karten.`
      : "Dieses Dashboard hat keine Ansichten.";
    container.append(h("div", "card hinweis", msg));
    return;
  }
  view.cards.forEach((c) => container.append(renderCard(c)));
  updateValues();
  loadAllGraphs();
}

function connectEvents(id) {
  clearTimeout(reconnectTimer);
  events?.close();
  let first = true;
  const es = new EventSource(`/api/events?dashboard=${encodeURIComponent(id)}`);
  events = es;
  es.addEventListener("snapshot", (ev) => {
    for (const k of Object.keys(states)) delete states[k];
    Object.assign(states, JSON.parse(ev.data));
    $("#status").classList.remove("off");
    updateValues();
    if (!first) loadAllGraphs(); // nach Neuverbindung Lücken im Verlauf schließen
    first = false;
  });
  es.addEventListener("change", (ev) => {
    const { entity, state } = JSON.parse(ev.data);
    if (state) states[entity] = state;
    else delete states[entity];
    updateValues();
    liveGraphs(entity, state);
  });
  es.addEventListener("template", (ev) => {
    const t = JSON.parse(ev.data);
    templates[t.id] = t.error ? { error: t.error } : { text: t.text ?? "" };
    document.querySelectorAll(`[data-md="${CSS.escape(t.id)}"]`).forEach((el) => renderMarkdownInto(el, t.id));
  });
  es.onerror = () => {
    $("#status").classList.add("off");
    // Bei einer Fehlerantwort (z. B. 503, HA nicht verbunden) gibt EventSource auf – selbst neu versuchen
    if (es.readyState === EventSource.CLOSED && events === es) {
      reconnectTimer = setTimeout(() => events === es && connectEvents(id), 5000);
    }
  };
}

let openSeq = 0;

async function openDashboard(id, viewPath) {
  const seq = ++openSeq;
  const res = await fetch(`/api/dashboards/${encodeURIComponent(id)}`);
  const data = await res.json();
  if (seq !== openSeq) return; // inzwischen wurde ein anderes Dashboard gewählt
  if (!res.ok) {
    dashboard = null;
    dashboardId = null;
    clearGraphs();
    events?.close();
    $("#title").textContent = data.error ?? "Fehler";
    $("#viewTitle").textContent = "";
    $("#cards").replaceChildren();
    renderNav();
    return;
  }
  dashboard = data;
  dashboardId = id;
  for (const k of Object.keys(templates)) delete templates[k];
  $("#title").textContent = dashboard.title;
  document.title = `${dashboard.title} – Home Assistant Reader free`;
  expanded.add(id); // geöffnetes Dashboard zeigt seine Ansichten
  const found = dashboard.views.findIndex((v) => v.path === viewPath);
  viewIndex = found >= 0 ? found : 0;
  renderView();
  connectEvents(id);
}

// ---------- Linke Navigation (Stil wie PFCG-Viewer) ----------

const expanded = new Set(); // Dashboards, deren Ansichten aufgeklappt sind

function navLink(href, icon, text, title) {
  const a = h("a", "hhNav-link");
  a.href = href;
  a.title = title ?? text;
  if (icon) {
    const i = h("span");
    i.dataset.icon = icon;
    a.append(i);
  }
  a.append(h("span", "hhNav-text", text));
  return a;
}

function renderNav() {
  const ul = $("#dashboards");
  ul.replaceChildren();
  for (const d of dashboards) {
    const isOpen = d.id === dashboardId && dashboard;
    const views = isOpen ? dashboard.views : [];
    const withViews = views.length > 1;
    const li = h("li");
    const row = h("div", "hhNav-eintrag");
    const link = navLink(`#${d.id}`, d.icon, d.title);
    if (isOpen) link.setAttribute("aria-current", withViews ? "true" : "page");
    row.append(link);

    if (withViews) {
      const auf = expanded.has(d.id);
      const btn = h("button", "hhNav-auf");
      btn.type = "button";
      btn.setAttribute("aria-expanded", String(auf));
      btn.title = auf ? "Ansichten zuklappen" : "Ansichten aufklappen";
      const chev = h("span");
      chev.dataset.icon = auf ? "mdi:chevron-down" : "mdi:chevron-right";
      btn.append(chev);
      btn.addEventListener("click", () => {
        if (auf) expanded.delete(d.id);
        else expanded.add(d.id);
        renderNav();
      });
      row.append(btn);
      li.append(row);

      const sub = h("ul", "hhNav-sub");
      sub.hidden = !auf;
      views.forEach((v, i) => {
        const sli = h("li");
        const srow = h("div", "hhNav-eintrag" + (i === viewIndex ? " aktiv" : ""));
        const sl = navLink(`#${d.id}/${v.path}`, null, v.title);
        if (i === viewIndex) sl.setAttribute("aria-current", "page");
        srow.append(sl);
        sli.append(srow);
        sub.append(sli);
      });
      li.append(sub);
      // zugeklappt: Auswahl am Dashboard zeigen, damit man sieht, wo man ist
      if (!auf) row.classList.add("aktiv");
    } else {
      if (isOpen) row.classList.add("aktiv");
      li.append(row);
    }
    ul.append(li);
  }
  applyIcons($("#nav"));
}

function setupNavToggle() {
  const btn = $("#navToggle");
  const set = (zu) => {
    document.body.classList.toggle("navZu", zu);
    btn.setAttribute("aria-expanded", String(!zu));
  };
  // Auf schmalen Bildschirmen eingeklappt starten (Zustand wird nicht gespeichert)
  set(window.matchMedia("(max-width: 700px)").matches);
  btn.addEventListener("click", () => {
    set(!document.body.classList.contains("navZu"));
    window.dispatchEvent(new Event("resize")); // Diagramme an neue Breite anpassen
  });
  applyIcons(btn);
}

// ---------- Ausgeblendete Dashboards (Rufzeichen in der Kopfzeile) ----------

function showHidden(hidden) {
  const btn = $("#hiddenInfo");
  btn.hidden = hidden.length === 0;
  if (!hidden.length) return;
  const text = hidden.length === 1 ? "1 Dashboard ausgeblendet" : `${hidden.length} Dashboards ausgeblendet`;
  $("#hiddenText").textContent = text;
  btn.title = `${text}: ${hidden.map((d) => d.title).join(", ")}`;
  const ul = $("#hiddenList");
  ul.replaceChildren();
  for (const d of hidden) {
    const li = h("li");
    li.append(h("strong", "", d.title), document.createTextNode(` – ${d.reason}`));
    ul.append(li);
  }
  if (!btn.dataset.ready) {
    btn.dataset.ready = "1";
    btn.addEventListener("click", () => $("#ausgeblendet").showModal());
  }
  applyIcons(btn);
}

// ---------- Impressum / Datenschutz ----------

// Anker der Dialoge (Vorgabe Design): #impressum, #datenschutz, #ueber; englische und alte Anker leiten um
const LEGAL_ALIAS = {
  imprint: "impressum", privacy: "datenschutz", about: "ueber", terms: "ueber",
  software: "ueber", nutzungsbedingungen: "ueber",
};
const LEGAL = new Set(["impressum", "datenschutz", "ueber", ...Object.keys(LEGAL_ALIAS)]);

function showLegal(which) {
  which = LEGAL_ALIAS[which] ?? which;
  if (which === "impressum" && $("#impressumLink").hidden) which = "ueber"; // kein Impressum eingetragen
  const dlg = document.getElementById(which);
  if (dlg && !dlg.open) dlg.showModal();
}

function setupLegal() {
  document.querySelectorAll("[data-legal]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault(); // Hash nicht ändern – der gehört dem Dashboard-Routing
      showLegal(a.dataset.legal);
    }),
  );
  document.querySelectorAll("dialog.hhDialog").forEach((dlg) => {
    dlg.querySelector("[data-close]")?.addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => e.target === dlg && dlg.close()); // Klick auf den Hintergrund
    dlg.addEventListener("close", () => {
      // direkt aufgerufenes #impressum/#datenschutz: danach zum Dashboard
      if (LEGAL.has(location.hash.slice(1))) {
        history.replaceState(null, "", location.pathname + location.search);
        route();
      }
    });
  });
}

/** Version und Angaben des Betreibers (aus der App-Konfiguration) – nur als Text einsetzen. */
async function loadInfo() {
  let info;
  try {
    info = await (await fetch("/api/info")).json();
  } catch {
    return; /* nur Anzeige */
  }
  if (info.version) {
    // wie auf tools.hammerherren.gmbh: "1.0" statt "1.0.0"
    $("#version").textContent = ` ${info.version}`;
    document.querySelectorAll("[data-version]").forEach((el) => (el.textContent = info.version));
  }
  // Steht die Hammerherren GmbH selbst als Betreiber im Impressum, steht links „© 2026“ statt „Software von“,
  // und die Sätze „die Herstellerin betreibt diese Seite nicht“ usw. entfallen
  const selbst = info.betrieb === "hammerherren";
  $("#herstellerVor").textContent = selbst ? "© 2026 " : "Software von ";
  document.querySelectorAll("[data-fremdbetrieb]").forEach((el) => (el.hidden = selbst));
  const b = info.betreiber;
  if (b?.name) {
    const dl = $("#impressumDaten");
    dl.replaceChildren();
    for (const [label, wert] of [
      ["Betreiber", b.name],
      ["Anschrift", b.anschrift],
      ["Kontakt", b.kontakt],
      ["Weitere Angaben", b.zusatz],
    ]) {
      if (wert) dl.append(h("dt", "", label), h("dd", "", wert));
    }
    $("#impressumLink").hidden = false;
    $("#dsVerantwortlich").textContent =
      `Verantwortlich für diese Seite ist ${[b.name, b.anschrift].filter(Boolean).join(", ")}` +
      (b.kontakt ? `. Kontakt: ${b.kontakt}` : "") + ". Weitere Angaben im Impressum.";
  }
  if (b?.datenschutzUrl) {
    $("#dsLinkA").href = b.datenschutzUrl;
    $("#dsLink").hidden = false;
  }
}

async function route() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (LEGAL.has(hash)) {
    showLegal(hash);
    if (dashboardId) return; // aktuelles Dashboard bleibt dahinter stehen
  }
  const [id, view] = LEGAL.has(hash) ? [] : hash.split("/");
  const target = id || dashboards[0]?.id;
  if (!target) return;
  if (dashboardId !== target) {
    await openDashboard(target, view);
  } else {
    const i = dashboard.views.findIndex((v) => v.path === view);
    viewIndex = i >= 0 ? i : 0;
    renderView();
  }
}

async function init() {
  if (!init.done) {
    init.done = true;
    setupLegal();
    setupNavToggle();
    await loadInfo(); // vor dem Routing: #impressum braucht die Betreiberangaben
  }
  const res = await fetch("/api/dashboards");
  const list = await res.json();
  if (!res.ok) {
    $("#title").textContent = list.error ?? "Fehler";
    setTimeout(init, 5000);
    return;
  }
  dashboards = list.dashboards;
  showHidden(list.hidden ?? []);
  renderNav();
  if (dashboards.length === 0) {
    $("#title").textContent = list.hidden?.length ? "Keine anzeigbaren Dashboards" : "Keine Dashboards gefunden";
    return;
  }
  window.addEventListener("hashchange", route);
  route();
  // Statistik ändert sich höchstens stündlich: alle 10 Minuten neu laden
  clearInterval(statsTimer);
  statsTimer = setInterval(() => loadAllGraphs("statistics"), 10 * 60 * 1000);
}

init();
