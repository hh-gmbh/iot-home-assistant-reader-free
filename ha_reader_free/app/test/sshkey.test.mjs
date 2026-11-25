// Schlüssel für die Zertifikatsabholung: neu erzeugen bzw. vom alten Dateinamen übernehmen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function frischesModul(dataDir) {
  process.env.DATA_DIR = dataDir;
  return import(`../dist/cert.js?d=${encodeURIComponent(dataDir)}`); // eigener Modulzustand je Verzeichnis
}

test("ohne vorhandenen Schlüssel wird ein neues ed25519-Paar erzeugt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reader-"));
  const { ensureSshKey } = await frischesModul(dir);
  const k = ensureSshKey();
  assert.match(k.publicLine, /^ssh-ed25519 \S+ home-assistant-reader zertabholung$/);
  assert.ok(existsSync(join(dir, "zertabholung_ed25519")));
  assert.equal(ensureSshKey().publicLine, k.publicLine, "zweiter Aufruf liefert denselben Schlüssel");
});

const PRIVAT = "-----BEGIN OPENSSH PRIVATE KEY-----\nALT\n-----END OPENSSH PRIVATE KEY-----\n";

test("vorhandenes Schlüsselpaar aus früherer Version wird übernommen, nicht neu erzeugt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reader-"));
  writeFileSync(join(dir, "options.json"), "{}");
  writeFileSync(join(dir, "alter_name"), PRIVAT);
  writeFileSync(join(dir, "alter_name.pub"), "ssh-ed25519 AAAAalt alt\n");
  const { ensureSshKey } = await frischesModul(dir);
  const k = ensureSshKey();
  assert.equal(k.publicLine, "ssh-ed25519 AAAAalt alt");
  assert.equal(k.privateKey.toString(), PRIVAT);
  assert.ok(!existsSync(join(dir, "alter_name")) && !existsSync(join(dir, "alter_name.pub")));
  assert.equal(readFileSync(join(dir, "zertabholung_ed25519"), "utf8"), PRIVAT);
});

test("eine .pub-Datei ohne passenden privaten OpenSSH-Schlüssel wird nicht übernommen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reader-"));
  writeFileSync(join(dir, "irgendwas"), "kein Schlüssel");
  writeFileSync(join(dir, "irgendwas.pub"), "ssh-ed25519 AAAAx x\n");
  const { ensureSshKey } = await frischesModul(dir);
  assert.match(ensureSshKey().publicLine, /home-assistant-reader zertabholung$/);
  assert.ok(existsSync(join(dir, "irgendwas")), "fremde Datei bleibt unangetastet");
});
