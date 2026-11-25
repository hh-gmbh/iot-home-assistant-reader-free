// Diagramme für history-graph / statistics-graph. Reine Funktionen: aus GraphData (vom Portal)
// werden ECharts-Optionen. Wie in HA: ein Diagramm je Einheit, nicht-numerische Zustände
// (an/aus, offen/zu …) als Stufenverlauf je Entität.

// Erste Farbe Hammerherren-Grün, danach gut unterscheidbare Töne für helle Flächen
const COLORS = ["#00753A", "#1F6FB2", "#C77700", "#B3261E", "#6B4FBB", "#00838F", "#8D5A2B", "#03B050"];
const MUTED = "#555B57";

const STATE_DE = {
  on: "An", off: "Aus", open: "Offen", closed: "Geschlossen", opening: "Öffnet", closing: "Schließt",
  locked: "Verriegelt", unlocked: "Entriegelt", home: "Zuhause", not_home: "Abwesend",
  unavailable: "Nicht verfügbar", unknown: "Unbekannt",
};

function baseOption(data) {
  return {
    backgroundColor: "transparent",
    animation: false,
    color: COLORS,
    grid: { left: 8, right: 12, top: 28, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", confine: true },
    xAxis: { type: "time", min: data.start, max: data.end, axisLabel: { hideOverlap: true } },
  };
}

/** Letzten Wert bis "jetzt" fortschreiben (HA macht das im Verlauf genauso). */
function extendToEnd(points, end) {
  if (points.length === 0) return points;
  const last = points[points.length - 1];
  return last[0] < end ? [...points, [end, last[1]]] : points;
}

/**
 * Liefert [{ key, title, height, option }]. key ist stabil (Einheit bzw. Entität),
 * damit Live-Updates dieselben Diagramm-Instanzen weiterverwenden.
 */
export function chartOptions(data) {
  const charts = [];
  const numeric = data.series.filter((s) => s.numeric);
  const states = data.series.filter((s) => !s.numeric);

  const byUnit = new Map();
  for (const s of numeric) {
    const u = s.unit ?? "";
    if (!byUnit.has(u)) byUnit.set(u, []);
    byUnit.get(u).push(s);
  }
  for (const [unit, list] of byUnit) {
    const opt = baseOption(data);
    // Legende oben in eigener Zeile, Einheit darunter über der Achse – nichts überlappt
    opt.legend = { top: 0, left: 0, right: 0, type: "scroll", itemHeight: 10, textStyle: { color: MUTED } };
    opt.grid = { ...opt.grid, top: unit ? 56 : 36 };
    opt.yAxis = { type: "value", scale: true, name: unit || undefined, nameGap: 12, nameTextStyle: { align: "left", color: MUTED } };
    opt.series = list.map((s) => ({
      name: s.name,
      type: data.chartType === "bar" ? "bar" : "line",
      step: data.kind === "history" ? "end" : undefined,
      showSymbol: false,
      connectNulls: false,
      data: data.kind === "history" ? extendToEnd(s.points, data.end) : s.points,
      tooltip: { valueFormatter: (v) => (v === null || v === undefined ? "–" : `${v}${unit ? " " + unit : ""}`) },
    }));
    charts.push({ key: `unit:${unit}`, height: 220, option: opt });
  }

  for (const s of states) {
    const pts = extendToEnd(s.points, data.end).map(([t, v]) => [t, STATE_DE[v] ?? v]);
    const categories = [...new Set(pts.map(([, v]) => v))];
    const opt = baseOption(data);
    opt.title = { text: s.name, textStyle: { fontSize: 12, color: MUTED, fontWeight: "normal" }, top: 0, left: 0 };
    opt.yAxis = { type: "category", data: categories };
    opt.series = [{ name: s.name, type: "line", step: "end", showSymbol: false, data: pts }];
    charts.push({ key: `state:${s.entity}`, height: 60 + 22 * categories.length, option: opt });
  }
  return charts;
}

/**
 * Live-Wert in die Verlaufsdaten übernehmen (nur history, nur numerisch bzw. Zustand).
 * Verschiebt das Zeitfenster auf jetzt und wirft Punkte vor dem Fenster weg (bis auf einen).
 */
export function appendLive(data, entity, state, now = Date.now()) {
  if (data.kind !== "history") return false;
  const span = data.end - data.start;
  data.end = now;
  data.start = now - span;
  let touched = false;
  for (const s of data.series) {
    if (s.entity !== entity || !state) continue;
    const raw = state.state;
    const unavailable = raw === "unavailable" || raw === "unknown";
    const v = s.numeric ? (unavailable ? null : Number(raw)) : raw;
    if (s.numeric && v !== null && !Number.isFinite(v)) continue;
    const last = s.points[s.points.length - 1];
    if (!last || last[1] !== v) s.points.push([now, v]);
    let cut = 0;
    while (cut + 1 < s.points.length && s.points[cut + 1][0] < data.start) cut++;
    if (cut > 0) s.points.splice(0, cut);
    touched = true;
  }
  return touched;
}
