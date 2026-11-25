#!/usr/bin/env node
// Zählt über alle Dashboards, welche Kartentypen im Portal als "unsupported" enden.
// Nur lesend (lovelace/dashboards/list, lovelace/config).
//
// Lokal:     HA_URL=http://homeassistant.local:8123 HA_TOKEN=<Token> npm run unsupported
// Im Add-on: docker exec addon_<…>_ha_reader_free node scripts/unsupported.mjs   (nutzt SUPERVISOR_TOKEN)
// Option --json für maschinenlesbare Ausgabe.
import { HaClient } from "../dist/ha.js";
import { convertDashboard, countUnsupported } from "../dist/cards.js";
import { haConnection } from "../dist/config.js";

const asJson = process.argv.includes("--json");
const { wsUrl, token } = haConnection();
const ha = new HaClient(wsUrl, token, (m) => !asJson && console.error(m));

const timeout = setTimeout(() => {
  console.error("Keine Verbindung zu Home Assistant innerhalb von 20 s");
  process.exit(2);
}, 20000);

ha.once("connected", async () => {
  clearTimeout(timeout);
  try {
    const list = await ha.request({ type: "lovelace/dashboards/list" });
    const targets = [{ id: "default", url_path: null }, ...list.filter((d) => d.url_path).map((d) => ({ id: d.url_path, url_path: d.url_path }))];
    const converted = [];
    const skipped = [];
    for (const t of targets) {
      try {
        const cfg = await ha.request({ type: "lovelace/config", url_path: t.url_path });
        converted.push({ id: t.id, dashboard: convertDashboard(cfg, t.id) });
      } catch (e) {
        skipped.push({ id: t.id, reason: e.message });
      }
    }
    const result = countUnsupported(converted);
    if (asJson) {
      console.log(JSON.stringify({ dashboards: converted.map((d) => d.id), skipped, unsupported: result }, null, 2));
    } else {
      console.log(`\nDashboards: ${converted.map((d) => d.id).join(", ")}`);
      for (const s of skipped) console.log(`Übersprungen: ${s.id} (${s.reason})`);
      if (result.length === 0) {
        console.log("\nKeine nicht unterstützten Karten. 🎉");
      } else {
        const w = Math.max(...result.map((r) => r.type.length), 8);
        console.log(`\n${"Kartentyp".padEnd(w)}  Anzahl  Dashboards`);
        for (const r of result) console.log(`${r.type.padEnd(w)}  ${String(r.count).padStart(6)}  ${r.dashboards.join(", ")}`);
        console.log(`\nGesamt: ${result.reduce((a, r) => a + r.count, 0)} Karten in ${result.length} Typen`);
      }
    }
    process.exit(0);
  } catch (e) {
    console.error(`Fehler: ${e.message}`);
    process.exit(1);
  }
});

ha.start();
