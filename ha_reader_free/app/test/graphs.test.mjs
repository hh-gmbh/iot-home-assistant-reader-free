import { test } from "node:test";
import assert from "node:assert/strict";
import { historySeries, statisticsSeries, loadGraph } from "../dist/graphs.js";

const states = new Map([
  ["sensor.temp", { state: "21", attributes: { friendly_name: "Wohnzimmer", unit_of_measurement: "°C" } }],
  ["binary_sensor.tuer", { state: "off", attributes: { friendly_name: "Tür" } }],
]);

test("Verlauf: numerisch vs. Zustand, Zeit in ms, unavailable als Lücke", () => {
  const card = { kind: "graph", id: "c0", type: "history-graph", entities: [{ entity: "sensor.temp" }, { entity: "binary_sensor.tuer", name: "Haustür" }], hours: 24 };
  const raw = {
    "sensor.temp": [{ s: "20.5", a: {}, lu: 1700000000 }, { s: "unavailable", lu: 1700000060 }, { s: "21", lu: 1700000120.5 }],
    "binary_sensor.tuer": [{ s: "off", lu: 1700000000 }, { s: "on", lu: 1700000100 }],
  };
  const [t, d] = historySeries(card, raw, states);
  assert.equal(t.numeric, true);
  assert.equal(t.name, "Wohnzimmer");
  assert.equal(t.unit, "°C");
  assert.deepEqual(t.points, [[1700000000000, 20.5], [1700000060000, null], [1700000120500, 21]]);
  assert.equal(d.numeric, false);
  assert.equal(d.name, "Haustür");
  assert.deepEqual(d.points, [[1700000000000, "off"], [1700000100000, "on"]]);
});

test("Statistik: mean wenn vorhanden, sonst change; Kartenangabe hat Vorrang", () => {
  const raw = {
    "sensor.temp": [{ start: 1700000000000, mean: 20, min: 19, max: 21 }],
    "sensor.energie": [{ start: 1700000000000, change: 1.5, state: 100 }],
  };
  const card = { kind: "graph", id: "c0", type: "statistics-graph", entities: [{ entity: "sensor.temp" }, { entity: "sensor.energie" }], hours: 24 };
  const s = statisticsSeries(card, raw, states);
  assert.deepEqual(s.map((x) => [x.entity, x.stat, x.points]), [
    ["sensor.temp", "mean", [[1700000000000, 20]]],
    ["sensor.energie", "change", [[1700000000000, 1.5]]],
  ]);
  const withTypes = statisticsSeries({ ...card, statTypes: ["min", "max"], entities: [{ entity: "sensor.temp" }] }, raw, states);
  assert.deepEqual(withTypes.map((x) => x.name), ["Wohnzimmer (Min)", "Wohnzimmer (Max)"]);
});

test("loadGraph fragt nur die Entitäten der Karte ab und nur lesend", async () => {
  const calls = [];
  const ha = { states, request: async (p) => (calls.push(p), {}) };
  const now = Date.UTC(2026, 10, 23, 12);
  await loadGraph({ kind: "graph", id: "c0", type: "history-graph", entities: [{ entity: "sensor.temp" }], hours: 2 }, ha, now);
  await loadGraph({ kind: "graph", id: "c1", type: "statistics-graph", entities: [{ entity: "sensor.temp" }], hours: 48, period: "day" }, ha, now);
  assert.equal(calls[0].type, "history/history_during_period");
  assert.deepEqual(calls[0].entity_ids, ["sensor.temp"]);
  assert.equal(calls[0].start_time, new Date(now - 2 * 3600e3).toISOString());
  assert.equal(calls[1].type, "recorder/statistics_during_period");
  assert.deepEqual(calls[1].statistic_ids, ["sensor.temp"]);
  assert.equal(calls[1].period, "day");
});

test("Karte ohne Entitäten löst keine Abfrage aus", async () => {
  const ha = { states, request: async () => assert.fail("keine Abfrage erwartet") };
  const d = await loadGraph({ kind: "graph", id: "c0", type: "history-graph", entities: [], hours: 24 }, ha);
  assert.deepEqual(d.series, []);
});
