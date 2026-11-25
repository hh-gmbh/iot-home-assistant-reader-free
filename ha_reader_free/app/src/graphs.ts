/**
 * Daten für history-graph und statistics-graph. Abgefragt werden immer nur die Entitäten
 * der jeweiligen Karte (aus dem Dashboard-Modell), nie vom Browser gewählte IDs.
 */
import type { Card, StatType } from "./cards.js";
import type { EntityState } from "./ha.js";

type GraphCard = Extract<Card, { kind: "graph" }>;

export interface Series {
  entity: string;
  name: string;
  unit?: string;
  /** numerisch: Linie/Balken; sonst Zustandsverlauf (Zeitleiste) */
  numeric: boolean;
  /** bei Statistik: welcher Wert (mean, state, …) */
  stat?: StatType;
  points: [number, number | string | null][];
}

export interface GraphData {
  kind: "history" | "statistics";
  start: number;
  end: number;
  chartType: "line" | "bar";
  series: Series[];
}

export interface GraphSource {
  request<T = unknown>(payload: Record<string, unknown>): Promise<T>;
  states: Map<string, EntityState>;
}

const UNAVAILABLE = new Set(["unavailable", "unknown", ""]);

function nameOf(ref: { entity: string; name?: string }, states: Map<string, EntityState>): string {
  const fn = states.get(ref.entity)?.attributes?.friendly_name;
  return ref.name ?? (typeof fn === "string" ? fn : ref.entity);
}

function unitOf(entity: string, states: Map<string, EntityState>): string | undefined {
  const u = states.get(entity)?.attributes?.unit_of_measurement;
  return typeof u === "string" && u ? u : undefined;
}

/** history/history_during_period mit minimal_response: [{s, lu|lc, a?}, …] je Entität. */
export function historySeries(
  card: GraphCard,
  raw: Record<string, any[]>,
  states: Map<string, EntityState>,
): Series[] {
  return card.entities.map((ref) => {
    const rows = Array.isArray(raw?.[ref.entity]) ? raw[ref.entity] : [];
    const pts: [number, string][] = [];
    for (const r of rows) {
      const t = typeof r?.lu === "number" ? r.lu : typeof r?.lc === "number" ? r.lc : null;
      if (t === null || typeof r?.s !== "string") continue;
      pts.push([Math.round(t * 1000), r.s]);
    }
    const known = pts.filter(([, s]) => !UNAVAILABLE.has(s));
    const numeric = known.length > 0 && known.every(([, s]) => Number.isFinite(Number(s)));
    return {
      entity: ref.entity,
      name: nameOf(ref, states),
      unit: unitOf(ref.entity, states),
      numeric,
      points: numeric
        ? pts.map(([t, s]) => [t, UNAVAILABLE.has(s) ? null : Number(s)] as [number, number | null])
        : pts,
    };
  });
}

/** Welche Statistikwerte gezeigt werden: Kartenangabe, sonst mean (Messwerte) bzw. change (Zähler). */
function pickStatTypes(card: GraphCard, rows: any[]): StatType[] {
  if (card.statTypes?.length) return card.statTypes;
  const has = (k: StatType) => rows.some((r) => typeof r?.[k] === "number");
  if (has("mean")) return ["mean"];
  if (has("change")) return ["change"];
  if (has("state")) return ["state"];
  return ["mean"];
}

const STAT_LABEL: Record<StatType, string> = {
  mean: "Mittel",
  min: "Min",
  max: "Max",
  state: "Stand",
  sum: "Summe",
  change: "Änderung",
};

/** recorder/statistics_during_period: [{start, end, mean, min, max, state, sum, change}] je Statistik. */
export function statisticsSeries(
  card: GraphCard,
  raw: Record<string, any[]>,
  states: Map<string, EntityState>,
): Series[] {
  const out: Series[] = [];
  for (const ref of card.entities) {
    const rows = Array.isArray(raw?.[ref.entity]) ? raw[ref.entity] : [];
    const types = pickStatTypes(card, rows);
    for (const stat of types) {
      const points: [number, number | null][] = [];
      for (const r of rows) {
        const t = typeof r?.start === "number" ? r.start : Date.parse(r?.start);
        if (!Number.isFinite(t)) continue;
        points.push([t, typeof r?.[stat] === "number" ? r[stat] : null]);
      }
      const base = nameOf(ref, states);
      out.push({
        entity: ref.entity,
        name: types.length > 1 ? `${base} (${STAT_LABEL[stat]})` : base,
        unit: unitOf(ref.entity, states),
        numeric: true,
        stat,
        points,
      });
    }
  }
  return out;
}

export async function loadGraph(card: GraphCard, ha: GraphSource, now = Date.now()): Promise<GraphData> {
  const end = now;
  const start = now - card.hours * 3600 * 1000;
  const ids = card.entities.map((e) => e.entity);
  const chartType = card.chartType ?? "line";
  if (ids.length === 0) return { kind: card.type === "history-graph" ? "history" : "statistics", start, end, chartType, series: [] };

  if (card.type === "history-graph") {
    const raw = await ha.request<Record<string, any[]>>({
      type: "history/history_during_period",
      start_time: new Date(start).toISOString(),
      end_time: new Date(end).toISOString(),
      entity_ids: ids,
      minimal_response: true,
      no_attributes: true,
      significant_changes_only: false,
    });
    return { kind: "history", start, end, chartType: "line", series: historySeries(card, raw, ha.states) };
  }

  const raw = await ha.request<Record<string, any[]>>({
    type: "recorder/statistics_during_period",
    start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(),
    statistic_ids: ids,
    period: card.period ?? "hour",
    types: card.statTypes?.length ? card.statTypes : ["mean", "min", "max", "state", "change"],
  });
  return { kind: "statistics", start, end, chartType, series: statisticsSeries(card, raw, ha.states) };
}
