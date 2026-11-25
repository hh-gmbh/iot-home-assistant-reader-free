// Icons (Material Design Icons) als Inline-SVG. Die Pfade kommen vom Portal (/api/icons),
// und zwar nur für die Namen, die auf der Seite wirklich vorkommen.
import { ICON_NAME } from "/markdown.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const known = new Map(); // Name → Pfad, oder null für unbekannt
const inflight = new Map(); // Name → Promise

/** Name für ein Element: data-icon (Zeilen, Kacheln) oder icon-Attribut (ha-icon aus Markdown). */
function nameOf(el) {
  const n = el.dataset.icon ?? el.getAttribute("icon") ?? "";
  return ICON_NAME.test(n) ? n : null;
}

async function fetchIcons(names) {
  const missing = names.filter((n) => !known.has(n) && !inflight.has(n));
  if (missing.length) {
    const p = fetch(`/api/icons?names=${encodeURIComponent(missing.join(","))}`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then((res) => {
        for (const n of missing) {
          known.set(n, typeof res[n] === "string" ? res[n] : null);
          inflight.delete(n);
        }
      });
    for (const n of missing) inflight.set(n, p);
  }
  await Promise.all(names.map((n) => inflight.get(n)).filter(Boolean));
}

function svg(path) {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", path);
  s.append(p);
  return s;
}

function draw(el) {
  const name = nameOf(el);
  if (el._drawn === name) return;
  const path = name ? known.get(name) : null;
  if (name && path === undefined) return; // wird noch geladen
  el._drawn = name;
  el.replaceChildren(...(path ? [svg(path)] : [])); // unbekannt → nichts anzeigen
}

/** Alle Icon-Platzhalter unter root zeichnen; fehlende Pfade gesammelt nachladen. */
export async function applyIcons(root = document) {
  const els = [...root.querySelectorAll("[data-icon], ha-icon")];
  if (els.length === 0) return;
  els.forEach(draw);
  const names = [...new Set(els.map(nameOf).filter(Boolean))].filter((n) => !known.has(n));
  if (names.length === 0) return;
  await fetchIcons(names);
  els.forEach(draw);
}
