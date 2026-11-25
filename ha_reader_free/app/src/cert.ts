import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from "node:fs";
import { X509Certificate, createPrivateKey, timingSafeEqual } from "node:crypto";
import ssh2 from "ssh2";
import SftpClient from "ssh2-sftp-client";
import type { Options } from "./config.js";

export interface CertPair {
  key: Buffer;
  cert: Buffer;
}

export interface CertInfo {
  subject: string;
  validTo: string;
  daysLeft: number;
}

const DATA_DIR = process.env.DATA_DIR ?? "/data";
const CACHE_DIR = `${DATA_DIR}/cert`;
const SSH_KEY = `${DATA_DIR}/zertabholung_ed25519`;
const SSH_KEY_COMMENT = "home-assistant-reader zertabholung";

/**
 * Schlüsselpaar für die Abholung per SFTP. Wird beim ersten Start erzeugt (ed25519)
 * und bleibt in /data. Gibt den öffentlichen Schlüssel als authorized_keys-Zeile zurück.
 */
/** Ein OpenSSH-Schlüsselpaar (Datei + Datei.pub) in /data, das nicht unter dem aktuellen Namen liegt. */
function vorhandenerSchluessel(): string | null {
  let namen: string[];
  try {
    namen = readdirSync(DATA_DIR);
  } catch {
    return null;
  }
  for (const n of namen.filter((x) => x.endsWith(".pub")).sort()) {
    const privat = `${DATA_DIR}/${n.slice(0, -4)}`;
    if (privat === SSH_KEY || !existsSync(privat)) continue;
    try {
      if (readFileSync(privat, "utf8").startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")) return privat;
    } catch {
      /* nicht lesbar: überspringen */
    }
  }
  return null;
}

export function ensureSshKey(): { privateKey: Buffer; publicLine: string } {
  const fehlt = (p: string) => !existsSync(p) || !existsSync(`${p}.pub`);
  const alt = fehlt(SSH_KEY) ? vorhandenerSchluessel() : null;
  if (alt) {
    // Schlüssel aus einer früheren Version unter anderem Namen: übernehmen, damit er auf dem
    // Server gültig bleibt. Erst .pub, dann den privaten Schlüssel umbenennen.
    renameSync(`${alt}.pub`, `${SSH_KEY}.pub`);
    renameSync(alt, SSH_KEY);
  }
  if (fehlt(SSH_KEY)) {
    mkdirSync(DATA_DIR, { recursive: true });
    const pair = ssh2.utils.generateKeyPairSync("ed25519", { comment: SSH_KEY_COMMENT });
    writeFileSync(SSH_KEY, pair.private, { mode: 0o600 });
    writeFileSync(`${SSH_KEY}.pub`, pair.public + "\n");
  }
  return {
    privateKey: readFileSync(SSH_KEY),
    publicLine: readFileSync(`${SSH_KEY}.pub`, "utf8").trim(),
  };
}

const KEY_TYPE = /^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Schlüsseltyp aus dem SSH-Wire-Format, oder null. Das Format ist eine Folge von Feldern
 * (4 Byte Länge + Inhalt): erst der Typname, dann mindestens ein Schlüsselfeld. Die Felder
 * müssen genau aufgehen – so fällt auch ein abgeschnittener Schlüssel auf.
 */
function wireKeyType(blob: Buffer): string | null {
  const fields: Buffer[] = [];
  let pos = 0;
  while (pos < blob.length) {
    if (pos + 4 > blob.length) return null;
    const len = blob.readUInt32BE(pos);
    if (pos + 4 + len > blob.length) return null;
    fields.push(blob.subarray(pos + 4, pos + 4 + len));
    pos += 4 + len;
  }
  if (fields.length < 2 || fields[0].length > 64) return null;
  const name = fields[0].toString("latin1");
  if (!KEY_TYPE.test(name)) return null;
  if (name === "ssh-ed25519" && (fields.length !== 2 || fields[1].length !== 32)) return null;
  return name;
}

/**
 * Hostschlüssel aus der Option sftp_host_key. Akzeptiert
 *   - eine known_hosts-Zeile:  "192.0.2.10 ssh-ed25519 AAAA…"
 *   - Typ und Schlüssel:       "ssh-ed25519 AAAA… [Kommentar]"
 *   - nur den Base64-Teil:     "AAAA…"
 * Liefert den rohen Schlüssel. Wirft bei unbrauchbarem Format eine Fehlermeldung, die sagt, was nicht passt.
 */
export function parseHostKey(value: string): Buffer {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error("Hostschlüssel ist leer");

  const typeIndex = parts.findIndex((p) => KEY_TYPE.test(p));
  let declared: string | null = null;
  let b64: string | undefined;
  if (typeIndex >= 0) {
    declared = parts[typeIndex];
    b64 = parts[typeIndex + 1];
    if (!b64) throw new Error(`nach dem Schlüsseltyp ${declared} fehlt der Base64-Teil`);
  } else {
    // kein Typ angegeben: das erste Stück, das nach Base64 aussieht (Adresse davor ist erlaubt)
    b64 = parts.find((p) => BASE64.test(p) && p.length >= 16);
    if (!b64) {
      throw new Error(
        `unbekanntes Format („${value.trim().slice(0, 40)}“) – erwartet „ssh-ed25519 AAAA…“, eine known_hosts-Zeile oder nur den Base64-Teil`,
      );
    }
  }
  if (!BASE64.test(b64)) throw new Error("der Schlüsselteil ist kein gültiges Base64");
  const blob = Buffer.from(b64, "base64");
  const actual = wireKeyType(blob);
  if (!actual) throw new Error("der Base64-Teil ist kein SSH-Schlüssel (falsch kopiert oder abgeschnitten?)");
  if (declared && declared !== actual) {
    throw new Error(`Typangabe ${declared} passt nicht zum Schlüssel (${actual})`);
  }
  return blob;
}

/** Prüft, ob Zertifikat und privater Schlüssel zusammenpassen; liefert Eckdaten des Zertifikats. */
export function checkPair(pair: CertPair): CertInfo {
  const x509 = new X509Certificate(pair.cert);
  if (!x509.checkPrivateKey(createPrivateKey(pair.key))) {
    throw new Error("Zertifikat und privater Schlüssel passen nicht zusammen");
  }
  const validTo = new Date(x509.validTo);
  return {
    subject: x509.subjectAltName ?? x509.subject,
    validTo: validTo.toISOString(),
    daysLeft: Math.floor((validTo.getTime() - Date.now()) / 86400000),
  };
}

async function fromSftp(o: Options): Promise<CertPair> {
  if (!o.sftp_host || !o.sftp_user || !o.sftp_fullchain_path || !o.sftp_privkey_path) {
    throw new Error("SFTP-Optionen unvollständig");
  }
  if (!o.sftp_host_key?.trim()) {
    throw new Error("Hostschlüssel des SFTP-Servers fehlt (Option sftp_host_key) – keine Verbindung ohne festgeschriebenen Hostschlüssel");
  }
  let pinned: Buffer;
  try {
    pinned = parseHostKey(o.sftp_host_key);
  } catch (e) {
    throw new Error(`Option sftp_host_key unbrauchbar: ${(e as Error).message}`);
  }

  const { privateKey } = ensureSshKey();
  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host: o.sftp_host,
      port: o.sftp_port,
      username: o.sftp_user,
      privateKey,
      readyTimeout: 15000,
      hostVerifier: (key: Buffer) => key.length === pinned.length && timingSafeEqual(key, pinned),
    });
    const cert = (await sftp.get(o.sftp_fullchain_path)) as Buffer;
    const key = (await sftp.get(o.sftp_privkey_path)) as Buffer;
    return { cert, key };
  } finally {
    await sftp.end().catch(() => undefined);
  }
}

function fromFiles(certPath: string, keyPath: string): CertPair | null {
  if (!existsSync(certPath) || !existsSync(keyPath)) return null;
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}

function saveCache(pair: CertPair): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  // erst schreiben, dann umbenennen: im Cache liegt nie ein halbes Paar
  writeFileSync(`${CACHE_DIR}/fullchain.pem.neu`, pair.cert);
  writeFileSync(`${CACHE_DIR}/privkey.pem.neu`, pair.key, { mode: 0o600 });
  renameSync(`${CACHE_DIR}/fullchain.pem.neu`, `${CACHE_DIR}/fullchain.pem`);
  renameSync(`${CACHE_DIR}/privkey.pem.neu`, `${CACHE_DIR}/privkey.pem`);
}

/**
 * Reihenfolge: gewählte Quelle (nur wenn Schlüssel und Zertifikat zusammenpassen),
 * dann zuletzt geholte Kopie, dann lokale Dateien. null = kein Zertifikat.
 */
export async function loadCertificate(o: Options, log: (m: string) => void): Promise<CertPair | null> {
  if (o.cert_source === "sftp") {
    try {
      const fresh = await fromSftp(o);
      const info = checkPair(fresh);
      saveCache(fresh);
      log(`Zertifikat per SFTP geholt: ${info.subject}, gültig bis ${info.validTo} (${info.daysLeft} Tage)`);
      return fresh;
    } catch (e) {
      log(`Zertifikat von ${o.sftp_host || "SFTP"} nicht übernommen: ${(e as Error).message}`);
    }
    const cached = fromFiles(`${CACHE_DIR}/fullchain.pem`, `${CACHE_DIR}/privkey.pem`);
    if (cached) {
      try {
        const info = checkPair(cached);
        log(`Verwende zuletzt geholtes Zertifikat (gültig bis ${info.validTo}, ${info.daysLeft} Tage)`);
        return cached;
      } catch (e) {
        log(`Zwischengespeichertes Zertifikat unbrauchbar: ${(e as Error).message}`);
      }
    }
  }
  const local = fromFiles(o.local_fullchain, o.local_privkey);
  if (local) {
    try {
      checkPair(local);
      log(`Verwende Zertifikat aus ${o.local_fullchain}`);
      return local;
    } catch (e) {
      log(`Lokales Zertifikat unbrauchbar: ${(e as Error).message}`);
    }
  }
  return null;
}
