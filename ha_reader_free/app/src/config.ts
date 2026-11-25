import { readFileSync, existsSync } from "node:fs";

export interface Options {
  hostname: string;
  cert_source: "sftp" | "local";
  sftp_host?: string;
  sftp_port: number;
  sftp_user?: string;
  sftp_host_key?: string;
  sftp_fullchain_path?: string;
  sftp_privkey_path?: string;
  local_fullchain: string;
  local_privkey: string;
  cert_refresh_hours: number;
  log_level: "debug" | "info" | "warn" | "error";
  betreiber_name?: string;
  betreiber_anschrift?: string;
  betreiber_kontakt?: string;
  betreiber_zusatz?: string;
  betreiber_datenschutz_url?: string;
}

const DEFAULTS: Options = {
  hostname: "homeassistant.local",
  cert_source: "local",
  sftp_host: "",
  sftp_port: 22,
  sftp_user: "",
  sftp_fullchain_path: "/fullchain.pem",
  sftp_privkey_path: "/privkey.pem",
  local_fullchain: "/ssl/fullchain.pem",
  local_privkey: "/ssl/privkey.pem",
  cert_refresh_hours: 24,
  log_level: "info",
  betreiber_name: "",
  betreiber_anschrift: "",
  betreiber_kontakt: "",
  betreiber_zusatz: "",
  betreiber_datenschutz_url: "",
};

/** Optionen: im Add-on aus /data/options.json, lokal aus OPTIONS_FILE oder Defaults. */
export function loadOptions(): Options {
  const file = process.env.OPTIONS_FILE ?? "/data/options.json";
  if (!existsSync(file)) return { ...DEFAULTS };
  return { ...DEFAULTS, ...JSON.parse(readFileSync(file, "utf8")) };
}

/** Zugang zu Home Assistant: im Add-on über den Supervisor, lokal über HA_URL + HA_TOKEN. */
export function haConnection(): { wsUrl: string; token: string } {
  if (process.env.SUPERVISOR_TOKEN) {
    return { wsUrl: "ws://supervisor/core/websocket", token: process.env.SUPERVISOR_TOKEN };
  }
  const url = process.env.HA_URL;
  const token = process.env.HA_TOKEN;
  if (!url || !token) {
    throw new Error("Weder SUPERVISOR_TOKEN noch HA_URL/HA_TOKEN gesetzt");
  }
  return { wsUrl: url.replace(/^http/, "ws").replace(/\/$/, "") + "/api/websocket", token };
}

export interface Betreiber {
  name: string;
  anschrift: string;
  kontakt: string;
  zusatz: string;
  datenschutzUrl: string;
}

const MAX_LEN = 500;
/** reiner Text, eine Zeile, ohne Steuerzeichen, gekürzt */
function text(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_LEN);
}

/**
 * Angaben des Betreibers für Impressum und Datenschutz – nur als Text für den Browser
 * (dort per textContent eingesetzt). Ohne Namen gibt es kein Impressum (null).
 * Der Link zur Datenschutzerklärung des Betreibers wird nur mit http(s) übernommen.
 */
export function betreiberAngaben(opts: Options): Betreiber | null {
  const name = text(opts.betreiber_name);
  let datenschutzUrl = text(opts.betreiber_datenschutz_url);
  try {
    const u = new URL(datenschutzUrl);
    datenschutzUrl = u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch {
    datenschutzUrl = "";
  }
  if (!name) return datenschutzUrl ? { name: "", anschrift: "", kontakt: "", zusatz: "", datenschutzUrl } : null;
  return {
    name,
    anschrift: text(opts.betreiber_anschrift),
    kontakt: text(opts.betreiber_kontakt),
    zusatz: text(opts.betreiber_zusatz),
    datenschutzUrl,
  };
}

/**
 * Wer betreibt die Seite? Die Hammerherren GmbH nur dann, wenn sie selbst als Betreiber im Impressum steht
 * (Option betreiber_name, ausgeliefert leer). Dann zeigt die Fußzeile „© 2026“ statt „Software von“, und die
 * Sätze „die Herstellerin betreibt diese Seite nicht“ entfallen. Alles andere ist ein fremder Betreiber.
 */
export function betriebsArt(opts: Options): "fremd" | "hammerherren" {
  const name = typeof opts.betreiber_name === "string" ? opts.betreiber_name.replace(/\s+/g, " ").trim().toLowerCase() : "";
  return name === "hammerherren gmbh" ? "hammerherren" : "fremd";
}
