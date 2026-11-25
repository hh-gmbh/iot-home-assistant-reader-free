// Sanitisierung der Markdown-Karten mit echtem DOMPurify in einem simulierten DOM (jsdom).
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import { Marked } from "marked";
import { renderMarkdown, sanitizeHtml } from "../public/markdown.js";

const { window } = new JSDOM("<!DOCTYPE html><body></body>");
const purify = createDOMPurify(window);

function html(frag) {
  const div = window.document.createElement("div");
  div.append(frag);
  return div.innerHTML;
}
const md = (src) => html(renderMarkdown(src, Marked, purify));
const clean = (src) => html(sanitizeHtml(src, purify));

// --- über den ganzen Weg (Markdown → marked → DOMPurify) ---

test("ha-icon mit gültigem Namen bleibt", () => {
  assert.equal(md('<ha-icon icon="mdi:fire"></ha-icon> Heizung'), '<p><ha-icon icon="mdi:fire"></ha-icon> Heizung</p>\n');
});

test("ha-icon: Schreibweisen ohne/mit einfachen Anführungszeichen und selbstschließend", () => {
  assert.match(md("<ha-icon icon='mdi:water-pump'/> Pumpe"), /<ha-icon icon="mdi:water-pump"><\/ha-icon> Pumpe/);
  assert.match(md("<ha-icon icon=mdi:numeric-1-box></ha-icon>"), /<ha-icon icon="mdi:numeric-1-box"><\/ha-icon>/);
});

test("ha-icon mit onclick wird entfernt", () => {
  const out = md('<ha-icon icon="mdi:fire" onclick="alert(1)"></ha-icon>Text');
  assert.doesNotMatch(out, /ha-icon|onclick|alert/);
  assert.match(out, /Text/);
});

test("ha-icon mit style wird entfernt", () => {
  assert.doesNotMatch(md('<ha-icon style="color:red" icon="mdi:fire"></ha-icon>x'), /ha-icon|style/);
});

test("ha-icon mit ungültigem Namen wird entfernt", () => {
  for (const name of ["fire", "mdi:Fire", "mdi:fire<script>", "hass:fire", "mdi:", "mdi:fire;x", 'mdi:fire" onclick="x']) {
    assert.doesNotMatch(md(`<ha-icon icon="${name}"></ha-icon>x`), /ha-icon|onclick|script/, name);
  }
});

test("<img> wird entfernt (HTML und Markdown-Bild)", () => {
  const out = md('Vorher <img src="http://fremd.example/x.png" onerror="alert(1)"> nachher\n\n![Kamera](http://fremd.example/k.jpg)');
  assert.doesNotMatch(out, /<img|fremd\.example|onerror|alert/);
  assert.match(out, /Vorher\s+nachher/);
});

test("sonstiges HTML bleibt draußen, Skripte ohne Wirkung", () => {
  const out = md('<b>fett</b> <span style="x">s</span> <svg onload="alert(1)"></svg> <iframe src="x"></iframe> <script>alert(1)</script>');
  assert.doesNotMatch(out, /<b>|<span|<svg|<iframe|<script|onload/);
});

// --- DOMPurify-Stufe allein (falls Stufe 1 etwas durchließe) ---

test("DOMPurify: ha-icon gültig bleibt, Inhalt wird geleert", () => {
  assert.equal(clean('<ha-icon icon="mdi:fire">Text</ha-icon>'), '<ha-icon icon="mdi:fire"></ha-icon>');
});

test("DOMPurify: ha-icon mit onclick, style oder weiterem Attribut wird entfernt", () => {
  assert.equal(clean('<ha-icon icon="mdi:fire" onclick="alert(1)"></ha-icon>'), "");
  assert.equal(clean('<ha-icon icon="mdi:fire" style="color:red"></ha-icon>'), "");
  assert.equal(clean('<ha-icon icon="mdi:fire" title="x"></ha-icon>'), "");
});

test("DOMPurify: ha-icon mit ungültigem oder fehlendem Namen wird entfernt", () => {
  assert.equal(clean('<ha-icon icon="javascript:alert(1)"></ha-icon>'), "");
  assert.equal(clean('<ha-icon icon="mdi:Fire"></ha-icon>'), "");
  assert.equal(clean("<ha-icon></ha-icon>"), "");
});

test("DOMPurify: icon-Attribut nur an ha-icon", () => {
  assert.equal(clean('<p icon="mdi:fire">x</p>'), "<p>x</p>");
});

test("DOMPurify: <img> wird entfernt", () => {
  assert.equal(clean('<p>a<img src="x" onerror="alert(1)">b</p>'), "<p>ab</p>");
});

test("Links: nur http(s)/mailto, öffnen in neuem Tab ohne Opener", () => {
  assert.match(md("[HA](https://example.org)"), /<a href="https:\/\/example.org" target="_blank" rel="noopener noreferrer">HA<\/a>/);
  assert.doesNotMatch(md("[x](javascript:alert(1))"), /javascript:/);
});
