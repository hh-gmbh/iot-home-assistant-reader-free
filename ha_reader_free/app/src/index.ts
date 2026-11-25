import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import type { Server as HttpsServer } from "node:https";
import { loadOptions, haConnection, betreiberAngaben, betriebsArt } from "./config.js";
import { HaClient, type EntityState } from "./ha.js";
import { convertDashboard, publicDashboard, findCard, markdownCards, validIcon, hiddenReason, type Dashboard } from "./cards.js";
import { loadGraph } from "./graphs.js";
import { lookupIcons } from "./icons.js";
import { loadCertificate, ensureSshKey, checkPair, type CertPair } from "./cert.js";

const opts = loadOptions();
const VERSION: string = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;
const PORT = Number(process.env.PORT ?? 8443);
const RETRY_WITHOUT_CERT_MS = 10 * 60 * 1000;
const here = dirname(fileURLToPath(import.meta.url));

function log(m: string): void {
  console.log(`[${new Date().toISOString()}] ${m}`);
}

const { wsUrl, token } = haConnection();
const ha = new HaClient(wsUrl, token, log);
ha.start();

// Schlüssel für die Zertifikatsabholung: beim ersten Start erzeugen und gut sichtbar ausgeben
const sshPublicKey = opts.cert_source === "sftp" ? ensureSshKey().publicLine : null;
if (sshPublicKey) {
  log("Öffentlicher Schlüssel für die Zertifikatsabholung (auf dem SFTP-Server in authorized_keys eintragen):");
  console.log(`\n    ${sshPublicKey}\n`);
}

interface DashboardInfo {
  id: string; // "default" oder url_path
  title: string;
  icon: string; // "mdi:…", für die Navigation
}

const DEFAULT_ICON = "mdi:view-dashboard";

const DEFAULT_TITLE = "Übersicht";

/** HA meldet "No config found", wenn ein Dashboard automatisch erzeugt wird (keine gespeicherte Config). */
function isNoConfig(e: unknown): boolean {
  return /no config found/i.test((e as Error)?.message ?? "");
}

interface HiddenDashboard {
  id: string;
  title: string;
  reason: string;
}

/**
 * Alle Dashboards, aufgeteilt in anzeigbare und ausgeblendete. Ausgeblendet werden Dashboards ohne
 * eine einzige Karte, von HA automatisch erzeugte (ein automatisch erzeugtes Standard-Dashboard
 * würde zudem alle Entitäten enthalten – das passt nicht zur Whitelist) und solche, die sich nicht
 * laden lassen.
 */
async function listDashboards(): Promise<{ dashboards: DashboardInfo[]; hidden: HiddenDashboard[] }> {
  const list = await ha.request<any[]>({ type: "lovelace/dashboards/list" });
  const all: DashboardInfo[] = [{ id: "default", title: DEFAULT_TITLE, icon: DEFAULT_ICON }];
  for (const d of list) {
    if (typeof d.url_path !== "string" || !d.url_path) continue;
    all.push({
      id: d.url_path,
      title: typeof d.title === "string" && d.title ? d.title : d.url_path,
      icon: validIcon(d.icon) ?? DEFAULT_ICON,
    });
  }
  const checked = await Promise.all(
    all.map(async (info): Promise<[DashboardInfo, string | null]> => {
      try {
        const cfg = await ha.request<any>({ type: "lovelace/config", url_path: info.id === "default" ? null : info.id });
        return [info, hiddenReason(convertDashboard(cfg, info.title))];
      } catch (e) {
        if (isNoConfig(e)) return [info, "wird von Home Assistant automatisch erzeugt"];
        if (!ha.connected) throw e;
        return [info, "konnte nicht geladen werden"];
      }
    }),
  );
  return {
    dashboards: checked.filter(([, r]) => r === null).map(([d]) => d),
    hidden: checked.filter(([, r]) => r !== null).map(([d, r]) => ({ id: d.id, title: d.title, reason: r! })),
  };
}

/** Titel aus lovelace/dashboards/list, falls die Config selbst keinen hat. */
async function dashboardTitle(id: string): Promise<string> {
  if (id === "default") return DEFAULT_TITLE;
  try {
    const list = await ha.request<any[]>({ type: "lovelace/dashboards/list" });
    const hit = list.find((d) => d.url_path === id);
    if (hit && typeof hit.title === "string" && hit.title) return hit.title;
  } catch {
    /* Titel ist nur Kosmetik */
  }
  return id;
}

async function getDashboard(id: string): Promise<Dashboard> {
  const [cfg, title] = await Promise.all([
    ha.request<any>({ type: "lovelace/config", url_path: id === "default" ? null : id }),
    dashboardTitle(id),
  ]);
  return convertDashboard(cfg, title);
}

function httpError(e: unknown): { code: number; body: { error: string } } {
  const message = (e as Error)?.message ?? String(e);
  if (!ha.connected) return { code: 503, body: { error: "Keine Verbindung zu Home Assistant" } };
  if (isNoConfig(e)) return { code: 404, body: { error: "Dashboard hat keine gespeicherte Konfiguration" } };
  return { code: 404, body: { error: message } };
}

// Browser-Bibliotheken lokal aus node_modules (kein CDN). Nur diese Dateien, nichts sonst.
const MODULES = join(here, "..", "node_modules");
const VENDOR: Record<string, string> = {
  "marked.js": join(MODULES, "marked/lib/marked.esm.js"),
  "purify.js": join(MODULES, "dompurify/dist/purify.es.mjs"),
  "echarts.js": join(MODULES, "echarts/dist/echarts.min.js"),
};
for (const [name, path] of Object.entries(VENDOR)) {
  if (!existsSync(path)) log(`WARNUNG: ${name} fehlt (${path}) – Markdown/Diagramme funktionieren nicht`);
}

// Zusätzliche Absicherung gegen eingeschleustes HTML/Script (z. B. aus Markdown-Karten)
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // ECharts setzt Inline-Styles
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

let current: CertPair | null = null;

async function buildApp(cert: CertPair | null): Promise<FastifyInstance> {
  const app: FastifyInstance = cert
    ? (Fastify({ https: { key: cert.key, cert: cert.cert }, logger: false }) as unknown as FastifyInstance)
    : Fastify({ logger: false });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Content-Security-Policy", CSP);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    return payload;
  });

  await app.register(fastifyStatic, { root: join(here, "..", "public") });

  app.get<{ Params: { file: string } }>("/vendor/:file", async (req, reply) => {
    const path = VENDOR[req.params.file];
    if (!path) return reply.code(404).send({ error: "unbekannt" });
    reply.type("text/javascript; charset=utf-8").header("Cache-Control", "public, max-age=86400");
    return reply.send(createReadStream(path));
  });

  // Angaben für Impressum und Datenschutz (Betreiber) und Version – nur Text
  const betreiber = betreiberAngaben(opts);
  const betrieb = betriebsArt(opts);
  if (!betreiber?.name) {
    log("Hinweis: Kein Impressum eingetragen (Optionen „Impressum: …“) – die Fußzeile zeigt dann keinen Impressum-Link.");
  }
  app.get("/api/info", async () => ({ version: VERSION, betrieb, betreiber }));

  app.get("/api/health", async () => {
    let certificate = null;
    if (current) {
      try {
        certificate = checkPair(current);
      } catch {
        certificate = null;
      }
    }
    return { version: VERSION, ha: ha.connected, hostname: opts.hostname, tls: !!cert, certificate, sshPublicKey };
  });

  // Nur die angefragten Icons (Pfad-Daten aus @mdi/js), nicht das ganze Paket
  app.get<{ Querystring: { names?: string } }>("/api/icons", async (req, reply) => {
    reply.header("Cache-Control", "public, max-age=86400");
    return lookupIcons(req.query.names);
  });

  app.get("/api/dashboards", async (_req, reply) => {
    try {
      return await listDashboards();
    } catch (e) {
      const { code, body } = httpError(e);
      return reply.code(code).send(body);
    }
  });

  app.get<{ Params: { id: string } }>("/api/dashboards/:id", async (req, reply) => {
    try {
      return publicDashboard(await getDashboard(req.params.id));
    } catch (e) {
      const { code, body } = httpError(e);
      return reply.code(code).send(body);
    }
  });

  // Diagrammdaten: nur für eine Graph-Karte dieses Dashboards und nur für deren Entitäten
  app.get<{ Params: { id: string; card: string } }>("/api/dashboards/:id/graphs/:card", async (req, reply) => {
    try {
      const card = findCard(await getDashboard(req.params.id), req.params.card);
      if (!card || card.kind !== "graph") return reply.code(404).send({ error: "Keine solche Diagrammkarte" });
      return await loadGraph(card, ha);
    } catch (e) {
      const { code, body } = httpError(e);
      return reply.code(code).send(body);
    }
  });

  // Live-Werte per Server-Sent Events, nur für die Entitäten des gewählten Dashboards.
  // Markdown-Karten: HA rendert das Template, an den Browser geht nur der fertige Text.
  app.get<{ Querystring: { dashboard?: string } }>("/api/events", async (req, reply) => {
    const id = req.query.dashboard ?? "default";
    let dashboard: Dashboard;
    try {
      dashboard = await getDashboard(id);
    } catch (e) {
      const { code, body } = httpError(e);
      reply.code(code).send(body);
      return;
    }
    const allowed = new Set(dashboard.entities);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const snapshot: Record<string, EntityState> = {};
    for (const e of allowed) {
      const s = ha.states.get(e);
      if (s) snapshot[e] = s;
    }
    send("snapshot", snapshot);

    const onChange = (entity: string, state: EntityState | null) => {
      if (allowed.has(entity)) send("change", { entity, state });
    };
    ha.on("change", onChange);

    let closed = false;
    const unsubscribers: (() => void)[] = [];
    for (const md of markdownCards(dashboard)) {
      ha.subscribe({ type: "render_template", template: md.template, report_errors: true, strict: false }, (ev) => {
        // nur Text bzw. Fehlermeldung weitergeben, nie die "listeners" (= benutzte Entitäten)
        if (typeof ev?.error === "string") send("template", { id: md.id, error: ev.error });
        else if ("result" in (ev ?? {})) send("template", { id: md.id, text: templateText(ev.result) });
      })
        .then((unsub) => (closed ? unsub() : unsubscribers.push(unsub)))
        .catch((e) => send("template", { id: md.id, error: (e as Error).message }));
    }

    // Verbindung zu HA weg: Stream beenden, der Browser verbindet sich neu (und abonniert neu)
    const onDisconnect = () => res.end();
    ha.once("disconnected", onDisconnect);

    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.raw.on("close", () => {
      closed = true;
      clearInterval(ping);
      ha.off("change", onChange);
      ha.off("disconnected", onDisconnect);
      unsubscribers.forEach((u) => u());
    });
  });

  return app;
}

function templateText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === null || result === undefined) return "";
  return typeof result === "object" ? JSON.stringify(result) : String(result);
}

async function serve(cert: CertPair | null): Promise<FastifyInstance> {
  const app = await buildApp(cert);
  await app.listen({ port: PORT, host: "0.0.0.0" });
  log(`Home Assistant Reader free läuft auf Port ${PORT} (${cert ? "https" : "http"}), Hostname ${opts.hostname}`);
  return app;
}

current = await loadCertificate(opts, log);
let app = await serve(current);

if (!current) {
  // Noch kein Zertifikat: vorerst http, alle 10 Minuten neu versuchen und dann auf https umschalten
  log("KEIN Zertifikat – Portal läuft vorerst ohne TLS (http), neuer Versuch alle 10 Minuten");
  const retry = setInterval(async () => {
    const fresh = await loadCertificate(opts, log);
    if (!fresh) return;
    clearInterval(retry);
    current = fresh;
    await app.close();
    app = await serve(fresh);
    startRefresh();
  }, RETRY_WITHOUT_CERT_MS);
} else {
  startRefresh();
}

// Zertifikat regelmäßig neu holen und ohne Neustart austauschen
function startRefresh(): void {
  setInterval(async () => {
    const fresh = await loadCertificate(opts, log);
    if (fresh && !fresh.cert.equals(current!.cert)) {
      (app.server as HttpsServer).setSecureContext({ key: fresh.key, cert: fresh.cert });
      current = fresh;
      log("Neues Zertifikat übernommen");
    }
  }, opts.cert_refresh_hours * 3600 * 1000);
}
