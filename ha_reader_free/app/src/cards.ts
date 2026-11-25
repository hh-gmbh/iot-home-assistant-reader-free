/**
 * Überführt eine Lovelace-Konfiguration in ein eigenes, schmales Ansichtsmodell.
 * Prinzip Whitelist: nur bekannte Kartentypen werden übernommen, und nur deren
 * Entitäten zählen zur Ansicht. Alles andere wird zu "unsupported" (ohne Entitäten).
 */

export interface EntityRef {
  entity: string;
  name?: string;
  /** Icon aus der Kartenkonfiguration (nur "mdi:name") */
  icon?: string;
}

/** Erlaubtes Icon-Format, überall gleich (Karten, Markdown, /api/icons). */
export const ICON_NAME = /^mdi:[a-z0-9-]+$/;

export function validIcon(v: unknown): string | undefined {
  return typeof v === "string" && ICON_NAME.test(v) ? v : undefined;
}

export type Card =
  | { kind: "entities"; title?: string; entities: EntityRef[] }
  | { kind: "glance"; title?: string; entities: EntityRef[] }
  | { kind: "single"; type: string; title?: string; entity: EntityRef; min?: number; max?: number }
  | {
      kind: "graph";
      id: string;
      type: "history-graph" | "statistics-graph";
      title?: string;
      entities: EntityRef[];
      hours: number;
      period?: StatPeriod;
      statTypes?: StatType[];
      chartType?: "line" | "bar";
    }
  | { kind: "markdown"; id: string; title?: string }
  | { kind: "heading"; text: string }
  | { kind: "stack"; direction: "vertical" | "horizontal" | "grid"; title?: string; cards: Card[] }
  | { kind: "unsupported"; type: string };

export interface View {
  title: string;
  path: string;
  icon?: string;
  /** Ansicht wird von HA automatisch erzeugt (Strategie) – im Portal nicht darstellbar */
  strategy?: string;
  cards: Card[];
}

export type StatPeriod = "5minute" | "hour" | "day" | "week" | "month";
export type StatType = "mean" | "min" | "max" | "state" | "sum" | "change";

export interface Dashboard {
  title: string;
  /** Dashboard wird von HA automatisch erzeugt (z. B. "map" bei der Karte) – keine eigenen Ansichten */
  strategy?: string;
  views: View[];
  entities: string[];
  /**
   * Markdown-Templates je Karten-ID. Bleiben auf dem Server (Template-Quelltext nennt
   * Entitäten, die nicht freigegeben sind) – siehe publicDashboard().
   */
  templates: Record<string, string>;
}

/** Was an den Browser geht: alles außer den Template-Quelltexten. */
export type PublicDashboard = Omit<Dashboard, "templates">;

export function publicDashboard(d: Dashboard): PublicDashboard {
  const { templates: _omit, ...rest } = d;
  return rest;
}

/** Obergrenzen, damit eine Karte keine beliebig großen Abfragen auslöst. */
export const MAX_HISTORY_HOURS = 24 * 31;
export const MAX_STATISTICS_HOURS = 24 * 366;
const PERIODS: StatPeriod[] = ["5minute", "hour", "day", "week", "month"];
const STAT_TYPES: StatType[] = ["mean", "min", "max", "state", "sum", "change"];

const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;

function toRef(e: unknown): EntityRef | null {
  if (typeof e === "string") return ENTITY_ID.test(e) ? { entity: e } : null;
  if (e && typeof e === "object" && typeof (e as any).entity === "string" && ENTITY_ID.test((e as any).entity)) {
    const r: EntityRef = { entity: (e as any).entity };
    if (typeof (e as any).name === "string") r.name = (e as any).name;
    const icon = validIcon((e as any).icon);
    if (icon) r.icon = icon;
    return r;
  }
  return null; // section-Zeilen, Buttons ohne Entität, Templates usw. fallen weg
}

function refs(list: unknown): EntityRef[] {
  return Array.isArray(list) ? list.map(toRef).filter((r): r is EntityRef => r !== null) : [];
}

function title(c: any): string | undefined {
  return typeof c.title === "string" ? c.title : typeof c.name === "string" ? c.name : undefined;
}

/** Laufender Zähler für Karten-IDs und Ablage der Templates beim Umwandeln eines Dashboards. */
export interface ConvertContext {
  next: number;
  templates: Record<string, string>;
}

function clampHours(h: unknown, fallback: number, max: number): number {
  return typeof h === "number" && Number.isFinite(h) && h > 0 ? Math.min(h, max) : fallback;
}

export function convertCard(c: any, ctx: ConvertContext = { next: 0, templates: {} }): Card {
  const type = typeof c?.type === "string" ? c.type : "?";
  switch (type) {
    case "entities":
      return { kind: "entities", title: title(c), entities: refs(c.entities) };
    case "glance":
      return { kind: "glance", title: title(c), entities: refs(c.entities) };
    case "tile":
    case "sensor":
    case "button":
    case "entity":
    case "gauge":
    case "thermostat":
    case "light": {
      const e = toRef(c.entity);
      if (!e) return { kind: "unsupported", type };
      if (typeof c.name === "string") e.name = c.name;
      const icon = validIcon(c.icon);
      if (icon) e.icon = icon;
      const card: Card = { kind: "single", type, entity: e };
      if (type === "gauge") {
        if (typeof c.min === "number") card.min = c.min;
        if (typeof c.max === "number") card.max = c.max;
      }
      return card;
    }
    case "history-graph":
      return {
        kind: "graph",
        id: `c${ctx.next++}`,
        type,
        title: title(c),
        entities: refs(c.entities),
        hours: clampHours(c.hours_to_show, 24, MAX_HISTORY_HOURS),
      };
    case "statistics-graph": {
      const card: Card = {
        kind: "graph",
        id: `c${ctx.next++}`,
        type,
        title: title(c),
        entities: refs(c.entities),
        hours: clampHours(typeof c.days_to_show === "number" ? c.days_to_show * 24 : undefined, 24 * 30, MAX_STATISTICS_HOURS),
        period: PERIODS.includes(c.period) ? c.period : "hour",
        chartType: c.chart_type === "bar" ? "bar" : "line",
      };
      if (Array.isArray(c.stat_types)) {
        const t = c.stat_types.filter((x: unknown): x is StatType => STAT_TYPES.includes(x as StatType));
        if (t.length) card.statTypes = t;
      }
      return card;
    }
    case "markdown": {
      const id = `c${ctx.next++}`;
      ctx.templates[id] = typeof c.content === "string" ? c.content : "";
      return { kind: "markdown", id, title: title(c) };
    }
    case "heading":
      return { kind: "heading", text: typeof c.heading === "string" ? c.heading : "" };
    case "vertical-stack":
    case "horizontal-stack":
    case "grid":
      return {
        kind: "stack",
        direction: type === "grid" ? "grid" : type === "vertical-stack" ? "vertical" : "horizontal",
        title: title(c),
        cards: Array.isArray(c.cards) ? c.cards.map((x: any) => convertCard(x, ctx)) : [],
      };
    default:
      return { kind: "unsupported", type };
  }
}

export function collectEntities(cards: Card[], into = new Set<string>()): Set<string> {
  for (const c of cards) {
    if (c.kind === "entities" || c.kind === "glance" || c.kind === "graph") c.entities.forEach((e) => into.add(e.entity));
    else if (c.kind === "single") into.add(c.entity.entity);
    else if (c.kind === "stack") collectEntities(c.cards, into);
  }
  return into;
}

function strategyType(o: any): string | undefined {
  const t = o?.strategy?.type;
  return typeof t === "string" && /^[a-z0-9_:-]{1,64}$/i.test(t) ? t : undefined;
}

export function convertDashboard(cfg: any, fallbackTitle: string): Dashboard {
  const ctx: ConvertContext = { next: 0, templates: {} };
  const views: View[] = (Array.isArray(cfg?.views) ? cfg.views : []).map((v: any, i: number) => {
    let raw: any[] = Array.isArray(v.cards) ? v.cards : [];
    // Sections-Layout: Karten der Abschnitte der Reihe nach übernehmen
    if (Array.isArray(v.sections)) {
      for (const s of v.sections) {
        raw = raw.concat([{ type: "vertical-stack", cards: Array.isArray(s.cards) ? s.cards : [] }]);
      }
    }
    // Ansicht mit nur einer Panel-Karte
    if (v.panel && raw.length === 0 && v.card) raw = [v.card];
    return {
      title: typeof v.title === "string" ? v.title : `Ansicht ${i + 1}`,
      path: typeof v.path === "string" ? v.path : String(i),
      ...(validIcon(v.icon) ? { icon: v.icon } : {}),
      ...(strategyType(v) ? { strategy: strategyType(v) } : {}),
      cards: raw.map((x) => convertCard(x, ctx)),
    };
  });
  const entities = new Set<string>();
  for (const v of views) collectEntities(v.cards, entities);
  const t = typeof cfg?.title === "string" && cfg.title.trim() ? cfg.title : fallbackTitle;
  const strategy = strategyType(cfg);
  return { title: t, ...(strategy ? { strategy } : {}), views, entities: [...entities].sort(), templates: ctx.templates };
}

/**
 * Warum ein Dashboard nicht angezeigt wird, oder null, wenn es etwas zu zeigen gibt.
 * Leer = keine einzige Karte in irgendeiner Ansicht (z. B. die von HA erzeugte Karte).
 */
function hasContent(cards: Card[]): boolean {
  return cards.some((c) => (c.kind === "stack" ? hasContent(c.cards) : true));
}

export function hiddenReason(d: Dashboard | PublicDashboard): string | null {
  if (d.views.some((v) => hasContent(v.cards))) return null;
  const strategy = d.strategy ?? d.views.find((v) => v.strategy)?.strategy;
  if (strategy) return `wird von Home Assistant automatisch erzeugt („${strategy}“)`;
  return "enthält keine Karten";
}

/** Sucht eine Karte (auch in Stacks) anhand ihrer ID. */
export function findCard(d: Dashboard | PublicDashboard, id: string): Card | undefined {
  const walk = (cards: Card[]): Card | undefined => {
    for (const c of cards) {
      if ((c.kind === "graph" || c.kind === "markdown") && c.id === id) return c;
      if (c.kind === "stack") {
        const hit = walk(c.cards);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  for (const v of d.views) {
    const hit = walk(v.cards);
    if (hit) return hit;
  }
  return undefined;
}

/** Alle Markdown-Karten eines Dashboards (für die Template-Abos). */
export function markdownCards(d: Dashboard): { id: string; template: string }[] {
  return Object.entries(d.templates).map(([id, template]) => ({ id, template }));
}

export interface UnsupportedCount {
  type: string;
  count: number;
  dashboards: string[];
}

/** Zählt über mehrere Dashboards, welche Kartentypen als "unsupported" enden (auch in Stacks). */
export function countUnsupported(dashboards: { id: string; dashboard: Dashboard | PublicDashboard }[]): UnsupportedCount[] {
  const byType = new Map<string, { count: number; dashboards: Set<string> }>();
  const walk = (cards: Card[], id: string) => {
    for (const c of cards) {
      if (c.kind === "unsupported") {
        const e = byType.get(c.type) ?? { count: 0, dashboards: new Set<string>() };
        e.count++;
        e.dashboards.add(id);
        byType.set(c.type, e);
      } else if (c.kind === "stack") walk(c.cards, id);
    }
  };
  for (const { id, dashboard } of dashboards) for (const v of dashboard.views) walk(v.cards, id);
  return [...byType.entries()]
    .map(([type, e]) => ({ type, count: e.count, dashboards: [...e.dashboards].sort() }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}
