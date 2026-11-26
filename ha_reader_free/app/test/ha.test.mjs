import { test } from "node:test";
import assert from "node:assert/strict";
import { HaClient, READ_ONLY_TYPES } from "../dist/ha.js";

test("Portal schickt nur lesende Nachrichtentypen", () => {
  for (const t of READ_ONLY_TYPES) assert.doesNotMatch(t, /call_service|execute_script|fire_event|set|update|delete|create/);
});

test("call_service wird abgelehnt, bevor etwas gesendet wird", async () => {
  const ha = new HaClient("ws://127.0.0.1:1", "x", () => {});
  await assert.rejects(ha.request({ type: "call_service", domain: "lock", service: "unlock" }), /nicht erlaubt/);
  await assert.rejects(ha.subscribe({ type: "subscribe_trigger" }, () => {}), /nicht erlaubt/);
});

// ---------- Wächter: hängende Verbindungen (z. B. Supervisor-Proxy während eines HA-Neustarts) ----------
import { createServer } from "node:net";
import { WebSocketServer } from "ws";
import { once } from "node:events";

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(bedingung, ms = 3000) {
  const ende = Date.now() + ms;
  while (!bedingung()) {
    if (Date.now() > ende) throw new Error("Zeit abgelaufen");
    await warte(20);
  }
}

/** Ein HA-Nachbau; stumm=true: nimmt die Verbindung an und schweigt. */
async function haNachbau() {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  const s = { stumm: false, keinPong: false, verbindungen: 0, wss };
  wss.on("connection", (sock) => {
    s.verbindungen++;
    if (s.stumm) return;
    sock.send(JSON.stringify({ type: "auth_required" }));
    sock.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.type === "auth") sock.send(JSON.stringify({ type: "auth_ok", ha_version: "test" }));
      else if (m.type === "ping" && !s.keinPong) sock.send(JSON.stringify({ id: m.id, type: "pong" }));
    });
  });
  s.url = `ws://127.0.0.1:${wss.address().port}`;
  return s;
}

const SCHNELL = { entitaeten: false, anmeldeFristMs: 150, herzschlagMs: 80, antwortFristMs: 80, wiederholungMs: 30 };

test("Server nimmt TCP an und antwortet nie: Zeitgrenze, danach neuer Versuch", async () => {
  let anrufe = 0;
  const srv = createServer((s) => { anrufe++; s.on("error", () => {}); });
  srv.listen(0);
  await once(srv, "listening");
  const log = [];
  const ha = new HaClient(`ws://127.0.0.1:${srv.address().port}`, "x", (m) => log.push(m), SCHNELL);
  ha.start();
  try {
    await bis(() => anrufe >= 2);
    assert.ok(log.some((m) => /keine Antwort von HA/.test(m)), log.join("\n"));
    assert.equal(ha.connected, false);
  } finally {
    ha.stop();
    srv.close();
  }
});

test("Verbindung schweigt nach dem Aufbau: Frist greift, sobald HA wieder antwortet, ist der Client verbunden", async () => {
  const s = await haNachbau();
  s.stumm = true;
  const log = [];
  const ha = new HaClient(s.url, "x", (m) => log.push(m), SCHNELL);
  ha.start();
  try {
    await bis(() => s.verbindungen >= 2);
    assert.equal(ha.connected, false);
    assert.ok(log.some((m) => /keine Antwort von HA \(warte auf Anmeldeaufforderung\)/.test(m)), log.join("\n"));
    s.stumm = false;
    await bis(() => ha.connected);
  } finally {
    ha.stop();
    s.wss.close();
  }
});

test("Bestehende Verbindung ohne Lebenszeichen wird erkannt und neu aufgebaut", async () => {
  const s = await haNachbau();
  const ereignisse = [];
  const ha = new HaClient(s.url, "x", () => {}, SCHNELL);
  ha.on("connected", () => ereignisse.push("connected"));
  ha.on("disconnected", () => ereignisse.push("disconnected"));
  ha.start();
  try {
    await bis(() => ha.connected);
    await warte(250); // mehrere Herzschläge mit Antwort: bleibt verbunden
    assert.equal(s.verbindungen, 1);
    s.keinPong = true;
    await bis(() => ereignisse.includes("disconnected"));
    s.keinPong = false;
    await bis(() => ha.connected && s.verbindungen >= 2);
    assert.deepEqual(ereignisse.slice(0, 3), ["connected", "disconnected", "connected"]);
  } finally {
    ha.stop();
    s.wss.close();
  }
});

test("Offene Anfragen werden beim Abbruch abgelehnt, stop() verbindet nicht neu", async () => {
  const s = await haNachbau();
  const ha = new HaClient(s.url, "x", () => {}, SCHNELL);
  ha.start();
  await bis(() => ha.connected);
  const anfrage = ha.request({ type: "lovelace/config" }); // Nachbau antwortet nicht
  ha.stop();
  await assert.rejects(anfrage, /getrennt/);
  const vorher = s.verbindungen;
  await warte(150);
  assert.equal(s.verbindungen, vorher);
  s.wss.close();
});
