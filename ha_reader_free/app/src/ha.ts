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

/**
 * Minimaler WebSocket-Client für Home Assistant.
 * Bewusst NUR lesend: es gibt keine Methode für call_service, und request()/subscribe()
 * lehnen Nachrichtentypen außerhalb der Liste READ_ONLY_TYPES ab.
 * Emittiert "connected", "disconnected" und "change" (entity_id, state | null).
 */
export class HaClient extends EventEmitter {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private subscriptionId?: number;
  private subscriptions = new Map<number, (event: any) => void>();
  readonly states = new Map<string, EntityState>();
  connected = false;

  constructor(private wsUrl: string, private token: string, private log: (m: string) => void) {
    super();
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.onmessage = (ev) => this.onMessage(JSON.parse(String(ev.data)));
    ws.onclose = () => {
      this.connected = false;
      for (const p of this.pending.values()) p.reject(new Error("Verbindung zu HA getrennt"));
      this.pending.clear();
      this.subscriptions.clear(); // Abos gelten nur für diese Verbindung
      if (this.ws === ws) this.emit("disconnected");
      this.log("HA-Verbindung getrennt, neuer Versuch in 5 s");
      setTimeout(() => this.connect(), 5000);
    };
    ws.onerror = () => {
      /* onclose folgt */
    };
  }

  private onMessage(msg: any): void {
    switch (msg.type) {
      case "auth_required":
        this.ws?.send(JSON.stringify({ type: "auth", access_token: this.token }));
        return;
      case "auth_ok":
        this.connected = true;
        this.log(`Mit Home Assistant ${msg.ha_version} verbunden`);
        this.subscribeEntities();
        this.emit("connected");
        return;
      case "auth_invalid":
        this.log(`HA-Anmeldung abgelehnt: ${msg.message}`);
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
    if (!READ_ONLY_TYPES.has(type)) {
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
