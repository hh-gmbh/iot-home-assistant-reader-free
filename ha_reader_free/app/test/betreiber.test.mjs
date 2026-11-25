import { test } from "node:test";
import assert from "node:assert/strict";
import { betreiberAngaben, betriebsArt } from "../dist/config.js";

const basis = { hostname: "x", cert_source: "local", sftp_port: 22, local_fullchain: "", local_privkey: "", cert_refresh_hours: 24, log_level: "info" };

test("ohne Namen kein Impressum", () => {
  assert.equal(betreiberAngaben({ ...basis }), null);
  assert.equal(betreiberAngaben({ ...basis, betreiber_name: "   " }), null);
});

test("Angaben werden übernommen, Steuerzeichen entfernt, gekürzt", () => {
  const b = betreiberAngaben({
    ...basis,
    betreiber_name: " Max Muster\n",
    betreiber_anschrift: "Musterstraße 1,\t1234 Musterort",
    betreiber_kontakt: "max@example.org",
    betreiber_zusatz: "x".repeat(800),
  });
  assert.equal(b.name, "Max Muster");
  assert.equal(b.anschrift, "Musterstraße 1, 1234 Musterort");
  assert.equal(b.kontakt, "max@example.org");
  assert.equal(b.zusatz.length, 500);
  assert.equal(b.datenschutzUrl, "");
});

test("Datenschutz-Link nur mit http(s)", () => {
  const mit = (u) => betreiberAngaben({ ...basis, betreiber_name: "A", betreiber_datenschutz_url: u }).datenschutzUrl;
  assert.equal(mit("https://example.org/datenschutz"), "https://example.org/datenschutz");
  assert.equal(mit("javascript:alert(1)"), "");
  assert.equal(mit("data:text/html,x"), "");
  assert.equal(mit("kein link"), "");
});

test("Link ohne Namen: kein Impressum, aber Link bleibt", () => {
  const b = betreiberAngaben({ ...basis, betreiber_datenschutz_url: "https://example.org/ds" });
  assert.equal(b.name, "");
  assert.equal(b.datenschutzUrl, "https://example.org/ds");
});

test("Betrieb: Hammerherren nur, wenn sie selbst als Betreiber eingetragen ist", () => {
  assert.equal(betriebsArt({ ...basis }), "fremd");
  assert.equal(betriebsArt({ ...basis, betreiber_name: "Max Muster" }), "fremd");
  assert.equal(betriebsArt({ ...basis, betreiber_name: "Hammerherren GmbH" }), "hammerherren");
  assert.equal(betriebsArt({ ...basis, betreiber_name: "  hammerherren   gmbh " }), "hammerherren");
  assert.equal(betriebsArt({ ...basis, betreiber_name: "Hammerherren GmbH & Co" }), "fremd");
  assert.equal(betriebsArt({ ...basis, betreiber_art: "hammerherren" }), "fremd"); // alte Option aus 1.1.9 zählt nicht
});
