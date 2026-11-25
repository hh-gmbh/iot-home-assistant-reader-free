import { test } from "node:test";
import assert from "node:assert/strict";
import { convertDashboard } from "../dist/cards.js";

test("bekannte Karten und Entitäten werden übernommen", () => {
  const d = convertDashboard(
    {
      title: "TOP 3a",
      views: [
        {
          title: "Übersicht",
          path: "uebersicht",
          cards: [
            { type: "entities", title: "Klima", entities: ["sensor.fewo_temp", { entity: "climate.fewo_sz2", name: "SZ 2" }, { type: "section" }] },
            { type: "vertical-stack", cards: [{ type: "tile", entity: "switch.griller" }, { type: "custom:apexcharts-card", series: [{ entity: "sensor.geheim" }] }] },
          ],
        },
      ],
    },
    "x",
  );
  assert.equal(d.title, "TOP 3a");
  assert.deepEqual(d.entities, ["climate.fewo_sz2", "sensor.fewo_temp", "switch.griller"]);
  const stack = d.views[0].cards[1];
  assert.equal(stack.kind, "stack");
  assert.equal(stack.cards[1].kind, "unsupported");
});

test("Custom-Karten geben keine Entitäten frei", () => {
  const d = convertDashboard({ views: [{ cards: [{ type: "custom:button-card", entity: "lock.haustuer" }] }] }, "x");
  assert.deepEqual(d.entities, []);
});

test("Sections-Layout wird aufgelöst", () => {
  const d = convertDashboard(
    { views: [{ type: "sections", sections: [{ cards: [{ type: "heading", heading: "Bad" }, { type: "sensor", entity: "sensor.bad_temp" }] }] }] },
    "x",
  );
  assert.deepEqual(d.entities, ["sensor.bad_temp"]);
});

import { publicDashboard, findCard, countUnsupported, markdownCards } from "../dist/cards.js";

test("Markdown: Template bleibt auf dem Server, Entitäten darin werden nicht freigegeben", () => {
  const d = convertDashboard(
    { views: [{ cards: [{ type: "markdown", title: "Info", content: "Tür: {{ states('lock.haustuer') }}" }] }] },
    "x",
  );
  const md = d.views[0].cards[0];
  assert.equal(md.kind, "markdown");
  assert.equal(md.title, "Info");
  assert.deepEqual(d.entities, []);
  assert.deepEqual(markdownCards(d), [{ id: md.id, template: "Tür: {{ states('lock.haustuer') }}" }]);
  const pub = publicDashboard(d);
  assert.equal("templates" in pub, false);
  assert.equal(JSON.stringify(pub).includes("lock.haustuer"), false);
});

test("Titel: Config-Titel vor Fallback, leerer Titel zählt nicht", () => {
  assert.equal(convertDashboard({ title: "FEWO 1", views: [] }, "Liste").title, "FEWO 1");
  assert.equal(convertDashboard({ views: [] }, "Aus der Liste").title, "Aus der Liste");
  assert.equal(convertDashboard({ title: "  ", views: [] }, "Aus der Liste").title, "Aus der Liste");
});

test("Graph-Karten bekommen eindeutige IDs, auch in Stacks, und sind auffindbar", () => {
  const d = convertDashboard(
    {
      views: [
        { cards: [{ type: "history-graph", entities: ["sensor.a"], hours_to_show: 6 }] },
        {
          cards: [
            {
              type: "vertical-stack",
              cards: [{ type: "statistics-graph", entities: ["sensor.b", "sensor:extern"], days_to_show: 7, period: "day", stat_types: ["max", "bogus"], chart_type: "bar" }],
            },
          ],
        },
      ],
    },
    "x",
  );
  const h = d.views[0].cards[0];
  const s = d.views[1].cards[0].cards[0];
  assert.notEqual(h.id, s.id);
  assert.equal(h.hours, 6);
  assert.equal(s.hours, 7 * 24);
  assert.equal(s.period, "day");
  assert.deepEqual(s.statTypes, ["max"]);
  assert.equal(s.chartType, "bar");
  assert.deepEqual(s.entities, [{ entity: "sensor.b" }]); // externe Statistik-IDs fallen weg
  assert.equal(findCard(d, s.id), s);
  assert.equal(findCard(d, "gibtsnicht"), undefined);
});

test("Zeitraum von Diagrammen ist begrenzt", () => {
  const d = convertDashboard({ views: [{ cards: [{ type: "history-graph", entities: ["sensor.a"], hours_to_show: 100000 }, { type: "statistics-graph", entities: ["sensor.a"], days_to_show: 5000 }] }] }, "x");
  assert.equal(d.views[0].cards[0].hours, 24 * 31);
  assert.equal(d.views[0].cards[1].hours, 24 * 366);
});

test("countUnsupported zählt über Dashboards und Stacks", () => {
  const a = convertDashboard({ views: [{ cards: [{ type: "custom:mushroom-card" }, { type: "map" }, { type: "grid", cards: [{ type: "map" }] }] }] }, "a");
  const b = convertDashboard({ views: [{ cards: [{ type: "map" }, { type: "entities", entities: [] }] }] }, "b");
  assert.deepEqual(countUnsupported([{ id: "a", dashboard: a }, { id: "b", dashboard: b }]), [
    { type: "map", count: 3, dashboards: ["a", "b"] },
    { type: "custom:mushroom-card", count: 1, dashboards: ["a"] },
  ]);
});

test("Strategie-Dashboards (z. B. Karte) werden erkannt, ohne Ansichten und ohne Entitäten", () => {
  const d = convertDashboard({ strategy: { type: "map" } }, "Karte");
  assert.equal(d.strategy, "map");
  assert.deepEqual(d.views, []);
  assert.deepEqual(d.entities, []);
  const v = convertDashboard({ views: [{ title: "Bereiche", strategy: { type: "areas" } }] }, "x");
  assert.equal(v.views[0].strategy, "areas");
  assert.equal(convertDashboard({ strategy: { type: "<script>" } }, "x").strategy, undefined);
});

import { hiddenReason } from "../dist/cards.js";

test("Ausblenden: leere und automatisch erzeugte Dashboards, sonst nicht", () => {
  assert.match(hiddenReason(convertDashboard({ strategy: { type: "map" } }, "Karte")), /automatisch erzeugt.*map/);
  assert.equal(hiddenReason(convertDashboard({ views: [{ title: "A", cards: [] }, { title: "B" }] }, "x")), "enthält keine Karten");
  assert.equal(hiddenReason(convertDashboard({ views: [] }, "x")), "enthält keine Karten");
  // eine einzige Karte genügt – auch eine nicht unterstützte (sie erscheint als Platzhalter)
  assert.equal(hiddenReason(convertDashboard({ views: [{ cards: [] }, { cards: [{ type: "custom:x" }] }] }, "x")), null);
  // leere Abschnitte/Stacks zählen nicht als Inhalt
  assert.equal(hiddenReason(convertDashboard({ views: [{ type: "sections", sections: [{ cards: [] }, { cards: [{ type: "vertical-stack", cards: [] }] }] }] }, "x")), "enthält keine Karten");
  assert.equal(hiddenReason(convertDashboard({ views: [{ type: "sections", sections: [{ cards: [{ type: "heading", heading: "Bad" }] }] }] }, "x")), null);
});
