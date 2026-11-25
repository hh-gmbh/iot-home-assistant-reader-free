// Browser-Module (public/) ohne Browser testen: Markdown-Umwandlung und Diagramm-Optionen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Marked } from "marked";
import { createMarkdown, stripHtml, ALLOWED_TAGS } from "../public/markdown.js";
import { chartOptions, appendLive } from "../public/charts.js";

const md = createMarkdown(Marked);

test("Markdown wird umgewandelt, Zeilenumbrüche wie in HA", () => {
  const html = md("## Strom\n**PV:** 3,2 kW\nHeute: 12 kWh\n\n| a | b |\n|---|---|\n| 1 | 2 |");
  assert.match(html, /<h2>Strom<\/h2>/);
  assert.match(html, /<strong>PV:<\/strong> 3,2 kW<br>/);
  assert.match(html, /<table>/);
});

test("rohes HTML kommt nicht durch – weder Block noch inline (außer gültigem ha-icon)", () => {
  const html = md('<script>alert(1)</script>\n\nText <img src=x onerror=alert(1)> und <b>fett</b>\n\n<div onclick="x()">Block</div>\n\n<ha-icon icon="mdi:fire" onclick="x()"></ha-icon>');
  assert.doesNotMatch(html, /<script|<img|onerror|onclick|<div|<b>|<ha-icon/i);
  assert.match(html, /fett/);
  assert.match(html, /Block/);
  assert.doesNotMatch(html, /alert/);
});

test("Bilder werden nicht eingebunden, nur ihr Alternativtext", () => {
  const html = md("![Kamera](http://fremd.example/x.png)");
  assert.doesNotMatch(html, /<img|fremd\.example/);
  assert.match(html, /Kamera/);
});

test("stripHtml escaped übrig gebliebene Zeichen", () => {
  assert.equal(stripHtml("<p>a &amp; b</p>"), "a &amp;amp; b");
  assert.equal(stripHtml("<scr<script>ipt>x"), "ipt&gt;x");
  assert.equal(stripHtml("<style>body{}</style>ok"), "ok");
});

test("Whitelist enthält keine gefährlichen Tags", () => {
  for (const t of ["script", "iframe", "img", "svg", "style", "object", "form", "input"]) assert.equal(ALLOWED_TAGS.includes(t), false);
});

test("Diagramme: eins je Einheit, Zustände je Entität", () => {
  const data = {
    kind: "history",
    start: 0,
    end: 1000,
    chartType: "line",
    series: [
      { entity: "sensor.a", name: "A", unit: "°C", numeric: true, points: [[0, 20]] },
      { entity: "sensor.b", name: "B", unit: "°C", numeric: true, points: [[0, 21]] },
      { entity: "sensor.c", name: "C", unit: "%", numeric: true, points: [[0, 50]] },
      { entity: "binary_sensor.d", name: "D", numeric: false, points: [[0, "off"], [500, "on"]] },
    ],
  };
  const charts = chartOptions(data);
  assert.deepEqual(charts.map((c) => c.key), ["unit:°C", "unit:%", "state:binary_sensor.d"]);
  assert.equal(charts[0].option.series.length, 2);
  assert.deepEqual(charts[0].option.series[0].data, [[0, 20], [1000, 20]]); // bis jetzt fortgeschrieben
  assert.deepEqual(charts[2].option.yAxis.data, ["Aus", "An"]);
});

test("Statistik als Balken, nicht fortgeschrieben", () => {
  const charts = chartOptions({ kind: "statistics", start: 0, end: 1000, chartType: "bar", series: [{ entity: "sensor.e", name: "E", unit: "kWh", numeric: true, points: [[0, 1]] }] });
  assert.equal(charts[0].option.series[0].type, "bar");
  assert.deepEqual(charts[0].option.series[0].data, [[0, 1]]);
});

test("Live-Werte verschieben das Fenster und hängen Punkte an", () => {
  const data = { kind: "history", start: 0, end: 100, chartType: "line", series: [{ entity: "sensor.a", numeric: true, points: [[0, 1], [10, 2], [50, 3]] }] };
  assert.equal(appendLive(data, "sensor.a", { state: "4" }, 130), true);
  assert.equal(data.start, 30);
  assert.deepEqual(data.series[0].points, [[10, 2], [50, 3], [130, 4]]); // ein Punkt vor dem Fenster bleibt
  assert.equal(appendLive(data, "sensor.x", { state: "1" }, 140), false);
  assert.equal(appendLive({ ...data, kind: "statistics" }, "sensor.a", { state: "5" }, 150), false);
});

test("Legende und Einheit überlappen nicht: Diagrammfläche beginnt unter beiden", () => {
  const [c] = chartOptions({ kind: "statistics", start: 0, end: 1, chartType: "bar", series: [{ entity: "sensor.e", name: "E", unit: "kWh", numeric: true, points: [] }] });
  assert.equal(c.option.legend.top, 0);
  assert.ok(c.option.grid.top >= 50, "Platz für Legende und Einheit");
  const [o] = chartOptions({ kind: "history", start: 0, end: 1, chartType: "line", series: [{ entity: "sensor.x", name: "X", numeric: true, points: [] }] });
  assert.ok(o.option.grid.top >= 30, "ohne Einheit nur Platz für die Legende");
});
