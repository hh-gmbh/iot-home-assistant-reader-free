import { EventEmitter } from "node:events";

export interface EntityState {
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: number;
  last_updated?: number;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Einzige Nachrichtentypen, die das Portal an HA schicken darf. */
export const READ_ONLY_TYPES = new Set([
  "subscribe_entities",
  "unsubscribe_events",
  "lovelace/config",
  "lovelace/dashboards/list",
  "render_template",
  "history/history_during_period",
  "recorder/statistics_during_period",
]);

export interface HaClientOptionen {
  /** Freigabeliste der Nachrichtentypen; Standard: READ_ONLY_TYPES */
  erlaubt?: ReadonlySet<string>;
  /** Zustände aller Entitäten abonnieren (Standard: ja) */
  entitaeten?: boolean;
  /** So lange darf Aufbau + Anmeldung dauern, sonst neuer Versuch (Standard 20 s) */
  anmeldeFristMs?: number;
  /** Abstand der Lebenszeichen (HA-„ping“) bei bestehender Verbindung (Standard 30 s) */
  herzschlagMs?: number;
  /** So lange wird auf „pong“ gewartet (Standard 10 s) */
  antwortFristMs?: number;
  /** Wartezeit bis zum nächsten Versuch (Standard 5 s) */
  wiederholungMs?: number;
}

/**
 * Minimaler WebSocket-Client für Home Assistant.
 * Bewusst NUR lesend: es gibt keine Methode für call_service, und request()/subscribe()
 * lehnen Nachrichtentypen außerhalb der Liste READ_ONLY_TYPES ab.
 * Emittiert "connected", "disconnected" und "change" (entity_id, state | null).
 *
 * Wächter: Startet HA neu, nimmt der Supervisor-Proxy die Verbindung unter Umständen an und antwortet nie –
 * ohne Zeitgrenze bliebe der Client dann für immer „getrennt“. Darum gilt eine Frist für Aufbau und
 * Anmeldung, und eine bestehende Verbindung wird mit „ping“ geprüft. Hängt etwas, wird neu verbunden.
 */
export class HaClient extends EventEmitter {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private subscriptionId?: number;
  private subscriptions = new Map<number, (event: any) => void>();
  readonly states = new Map<string, EntityState>();
  connected = false;

  private erlaubt: ReadonlySet<string>;
  private entitaeten: boolean;
  private anmeldeFristMs: number;
  private herzschlagMs: number;
  private antwortFristMs: number;
  private wiederholungMs: number;
  private stufe = "Verbindungsaufbau";
  private frist?: NodeJS.Timeout;
  private herzschlag?: NodeJS.Timeout;
  private naechster?: NodeJS.Timeout;
  private pingId?: number;
  private beendet = false;

  constructor(private wsUrl: string, private token: string, private log: (m: string) => void, optionen: HaClientOptionen = {}) {
    super();
    this.erlaubt = optionen.erlaubt ?? READ_ONLY_TYPES;
    this.entitaeten = optionen.entitaeten ?? true;
    this.anmeldeFristMs = optionen.anmeldeFristMs ?? 20_000;
    this.herzschlagMs = optionen.herzschlagMs ?? 30_000;
    this.antwortFristMs = optionen.antwortFristMs ?? 10_000;
    this.wiederholungMs = optionen.wiederholungMs ?? 5_000;
  }

  start(): void {
    this.beendet = false;
    this.connect();
  }

  /** Verbindung schließen und nicht mehr neu verbinden (für Tests und Herunterfahren). */
  stop(): void {
    this.beendet = true;
    clearTimeout(this.naechster);
    const ws = this.ws;
    if (ws) this.getrennt(ws, "beendet");
  }

  private connect(): void {
    if (this.beendet) return;
    let ws: WebSocket;
    this.stufe = "Verbindungsaufbau";
    try {
      ws = new WebSocket(this.wsUrl);
    } catch (e) {
      this.log(`HA-Verbindung nicht möglich: ${(e as Error).message}, neuer Versuch in ${this.wiederholungMs / 1000} s`);
      this.naechster = setTimeout(() => this.connect(), this.wiederholungMs);
      return;
    }
    this.ws = ws;
    this.frist = setTimeout(
      () => this.getrennt(ws, `keine Antwort von HA (${this.stufe}) nach ${this.anmeldeFristMs / 1000} s`),
      this.anmeldeFristMs,
    );
    ws.onopen = () => {
      if (this.ws === ws) this.stufe = "warte auf Anmeldeaufforderung";
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return; // Nachzügler einer alten Verbindung
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.onMessage(ws, msg);
    };
    ws.onclose = (ev) => this.getrennt(ws, `geschlossen${ev.code ? ` (Code ${ev.code}${ev.reason ? `, ${ev.reason}` : ""})` : ""}`);
    ws.onerror = () => {
      /* onclose folgt */
    };
  }

  /** Eine Verbindung aufgeben: genau einmal je Verbindung, danach neuer Versuch. */
  private getrennt(ws: WebSocket, grund: string): void {
    if (this.ws !== ws) return;
    this.ws = undefined;
    clearTimeout(this.frist);
    clearInterval(this.herzschlag);
    this.pingId = undefined;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* schon zu */
    }
    const warVerbunden = this.connected;
    this.connected = false;
    for (const p of this.pending.values()) p.reject(new Error("Verbindung zu HA getrennt"));
    this.pending.clear();
    this.subscriptions.clear(); // Abos gelten nur für diese Verbindung
    if (warVerbunden) this.emit("disconnected");
    if (this.beendet) return;
    this.log(`HA-Verbindung getrennt: ${grund}, neuer Versuch in ${this.wiederholungMs / 1000} s`);
    this.naechster = setTimeout(() => this.connect(), this.wiederholungMs);
  }

  /** Lebenszeichen: „ping“ (kein Datenzugriff), ohne „pong“ binnen Frist gilt die Verbindung als tot. */
  private starteHerzschlag(ws: WebSocket): void {
    clearInterval(this.herzschlag);
    this.herzschlag = setInterval(() => {
      if (this.ws !== ws) return;
      if (this.pingId !== undefined) return this.getrennt(ws, `keine Antwort auf Lebenszeichen nach ${this.antwortFristMs / 1000} s`);
      const id = this.nextId++;
      this.pingId = id;
      ws.send(JSON.stringify({ id, type: "ping" }));
      clearTimeout(this.frist);
      this.frist = setTimeout(() => {
        if (this.pingId === id) this.getrennt(ws, `keine Antwort auf Lebenszeichen nach ${this.antwortFristMs / 1000} s`);
      }, this.antwortFristMs);
    }, this.herzschlagMs);
  }

  private onMessage(ws: WebSocket, msg: any): void {
    switch (msg.type) {
      case "auth_required":
        this.stufe = "Anmeldung";
        ws.send(JSON.stringify({ type: "auth", access_token: this.token }));
        return;
      case "auth_ok":
        clearTimeout(this.frist);
        this.connected = true;
        this.log(`Mit Home Assistant ${msg.ha_version} verbunden`);
        if (this.entitaeten) this.subscribeEntities();
        this.starteHerzschlag(ws);
        this.emit("connected");
        return;
      case "auth_invalid":
        this.stufe = "Anmeldung abgelehnt";
        this.log(`HA-Anmeldung abgelehnt: ${msg.message}`);
        return;
      case "pong":
        if (msg.id === this.pingId) {
          this.pingId = undefined;
          clearTimeout(this.frist);
        }
        return;
      case "result": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.success) p.resolve(msg.result);
        else p.reject(new Error(msg.error?.message ?? "HA-Fehler"));
        return;
      }
      case "event":
        if (msg.id === this.subscriptionId) this.applyCompressed(msg.event);
        else this.subscriptions.get(msg.id)?.(msg.event);
        return;
    }
  }

  request<T = unknown>(payload: Record<string, unknown>): Promise<T> {
    return this.send<T>(payload).promise;
  }

  /**
   * Abo (z. B. render_template). onEvent bekommt jedes Ereignis; das Ergebnis ist eine Funktion
   * zum Abbestellen. Bricht die Verbindung ab, endet das Abo (Ereignis "disconnected").
   */
  async subscribe(payload: Record<string, unknown>, onEvent: (event: any) => void): Promise<() => void> {
    const { id, promise } = this.send(payload, onEvent);
    try {
      await promise;
    } catch (e) {
      this.subscriptions.delete(id);
      throw e;
    }
    const ws = this.ws;
    return () => {
      if (!this.subscriptions.delete(id) || this.ws !== ws || !this.connected) return;
      this.request({ type: "unsubscribe_events", subscription: id }).catch(() => undefined);
    };
  }

  private send<T>(payload: Record<string, unknown>, onEvent?: (event: any) => void): { id: number; promise: Promise<T> } {
    const type = String(payload.type);
    if (!this.erlaubt.has(type)) {
      return { id: -1, promise: Promise.reject(new Error(`Nachrichtentyp ${type} ist im Portal nicht erlaubt (nur lesend)`)) };
    }
    if (!this.ws || !this.connected) return { id: -1, promise: Promise.reject(new Error("Nicht mit HA verbunden")) };
    const id = this.nextId++;
    if (onEvent) this.subscriptions.set(id, onEvent);
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify({ id, ...payload }));
    });
    return { id, promise };
  }

  private subscribeEntities(): void {
    const id = this.nextId++;
    this.subscriptionId = id;
    this.states.clear();
    this.pending.set(id, { resolve: () => undefined, reject: (e) => this.log(String(e)) });
    this.ws!.send(JSON.stringify({ id, type: "subscribe_entities" }));
  }

  /** Komprimiertes Format von subscribe_entities: a = neu, c = Änderung, r = entfernt. */
  private applyCompressed(ev: any): void {
    if (ev.a) {
      for (const [id, s] of Object.entries<any>(ev.a)) {
        const st: EntityState = { state: s.s, attributes: s.a ?? {}, last_changed: s.lc, last_updated: s.lu ?? s.lc };
        this.states.set(id, st);
        this.emit("change", id, st);
      }
    }
    if (ev.c) {
      for (const [id, diff] of Object.entries<any>(ev.c)) {
        const cur = this.states.get(id);
        if (!cur) continue;
        const next: EntityState = { ...cur, attributes: { ...cur.attributes } };
        const plus = diff["+"];
        if (plus) {
          if ("s" in plus) next.state = plus.s;
          if (plus.a) Object.assign(next.attributes, plus.a);
          if (plus.lc) next.last_changed = plus.lc;
          if (plus.lu) next.last_updated = plus.lu;
        }
        const minus = diff["-"];
        if (minus?.a) for (const k of minus.a) delete next.attributes[k];
        this.states.set(id, next);
        this.emit("change", id, next);
      }
    }
    if (ev.r) {
      for (const id of ev.r) {
        this.states.delete(id);
        this.emit("change", id, null);
      }
    }
  }
}
