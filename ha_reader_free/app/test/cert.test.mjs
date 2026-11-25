import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHostKey } from "../dist/cert.js";

const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIJhcb9it7j9mUVafn3UKEJhk+qwUReMCGq8+i5FAuZ07";
const RAW = Buffer.from(KEY, "base64");

test("Hostschlüssel aus known_hosts-Zeile mit Adresse", () => {
  assert.deepEqual(parseHostKey(`192.0.2.10 ssh-ed25519 ${KEY}`), RAW);
});

test("Hostschlüssel ohne Adresse und mit Kommentar", () => {
  assert.deepEqual(parseHostKey(`ssh-ed25519 ${KEY} root@server`), RAW);
});

test("bloßer Base64-Teil wird akzeptiert (auch mit Leerzeichen/Zeilenumbruch drumherum)", () => {
  assert.deepEqual(parseHostKey(KEY), RAW);
  assert.deepEqual(parseHostKey(`  ${KEY}\n`), RAW);
});

test("Adresse plus bloßer Base64-Teil wird akzeptiert", () => {
  assert.deepEqual(parseHostKey(`192.0.2.10 ${KEY}`), RAW);
});

test("leere Angabe: klare Meldung", () => {
  assert.throws(() => parseHostKey("   "), /leer/);
});

test("Platzhalter oder Unsinn: Meldung nennt das erwartete Format", () => {
  assert.throws(() => parseHostKey("192.0.2.10 <HOSTSCHLÜSSEL>"), /unbekanntes Format.*ssh-ed25519/);
});

test("Typ ohne Schlüssel", () => {
  assert.throws(() => parseHostKey("ssh-ed25519"), /fehlt der Base64-Teil/);
});

test("abgeschnittener oder fremder Base64-Text ist kein SSH-Schlüssel", () => {
  assert.throws(() => parseHostKey(KEY.slice(0, 20)), /kein SSH-Schlüssel/);
  assert.throws(() => parseHostKey(Buffer.from("das ist kein schlüssel, nur text").toString("base64")), /kein SSH-Schlüssel/);
});

test("Typangabe passt nicht zum Schlüssel", () => {
  assert.throws(() => parseHostKey(`ssh-rsa ${KEY}`), /passt nicht.*ssh-ed25519/);
});
