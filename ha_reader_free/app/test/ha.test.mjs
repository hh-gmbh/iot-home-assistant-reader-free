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
