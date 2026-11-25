/**
 * Material Design Icons aus @mdi/js. Der Browser bekommt nur die Pfade der Icons,
 * die er tatsächlich braucht (über /api/icons), nie das ganze Paket.
 */
import * as mdi from "@mdi/js";
import { ICON_NAME } from "./cards.js";

export const MAX_ICONS_PER_REQUEST = 200;

const paths = mdi as unknown as Record<string, string>;

/** "mdi:water-pump" → "mdiWaterPump" (Schema der Exporte von @mdi/js) */
export function exportName(icon: string): string {
  return (
    "mdi" +
    icon
      .slice(4)
      .split("-")
      .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : ""))
      .join("")
  );
}

/** SVG-Pfad (viewBox 0 0 24 24) oder undefined für ungültige/unbekannte Namen. */
export function iconPath(icon: string): string | undefined {
  if (!ICON_NAME.test(icon)) return undefined;
  const key = exportName(icon);
  return Object.hasOwn(paths, key) && typeof paths[key] === "string" ? paths[key] : undefined;
}

/** Für /api/icons?names=mdi:a,mdi:b – unbekannte Namen fehlen einfach im Ergebnis. */
export function lookupIcons(namesParam: unknown): Record<string, string> {
  const raw = typeof namesParam === "string" ? namesParam : Array.isArray(namesParam) ? namesParam.join(",") : "";
  const names = [...new Set(raw.split(",").map((n) => n.trim()).filter(Boolean))].slice(0, MAX_ICONS_PER_REQUEST);
  const out: Record<string, string> = {};
  for (const n of names) {
    const p = iconPath(n);
    if (p) out[n] = p;
  }
  return out;
}
