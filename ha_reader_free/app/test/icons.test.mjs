import { test } from "node:test";
import assert from "node:assert/strict";
import { mdiFire, mdiWaterPump, mdiNumeric1Box } from "@mdi/js";
import { exportName, iconPath, lookupIcons, MAX_ICONS_PER_REQUEST } from "../dist/icons.js";
import { convertDashboard } from "../dist/cards.js";

test("Namensschema mdi:name → @mdi/js-Export", () => {
  assert.equal(exportName("mdi:water-pump"), "mdiWaterPump");
  assert.equal(iconPath("mdi:fire"), mdiFire);
  assert.equal(iconPath("mdi:numeric-1-box"), mdiNumeric1Box);
});

test("unbekannte oder ungültige Namen liefern nichts", () => {
  for (const n of ["mdi:gibt-es-nicht", "fire", "mdi:Fire", "mdi:constructor", "mdi:to-string", "mdi:__proto__"]) {
    assert.equal(iconPath(n), undefined, n);
  }
});

test("/api/icons: nur angefragte, bekannte Icons", () => {
  const r = lookupIcons("mdi:fire,mdi:water-pump,mdi:gibt-es-nicht,<script>,mdi:fire");
  assert.deepEqual(r, { "mdi:fire": mdiFire, "mdi:water-pump": mdiWaterPump });
  assert.deepEqual(lookupIcons(undefined), {});
});

test("/api/icons: Anzahl je Anfrage begrenzt", () => {
  const names = Array.from({ length: 500 }, (_, i) => `mdi:numeric-${i}`).join(",");
  assert.ok(Object.keys(lookupIcons(names)).length <= MAX_ICONS_PER_REQUEST);
});

test("Icons aus der Kartenkonfiguration, nur gültiges Format", () => {
  const d = convertDashboard(
    {
      views: [
        {
          cards: [
            { type: "entities", entities: [{ entity: "sensor.a", icon: "mdi:fire" }, { entity: "sensor.b", icon: "javascript:x" }, "sensor.c"] },
            { type: "tile", entity: "switch.pumpe", icon: "mdi:water-pump" },
            { type: "glance", entities: [{ entity: "sensor.d", icon: "mdi:thermometer" }] },
          ],
        },
      ],
    },
    "x",
  );
  const [ent, tile, glance] = d.views[0].cards;
  assert.deepEqual(ent.entities, [{ entity: "sensor.a", icon: "mdi:fire" }, { entity: "sensor.b" }, { entity: "sensor.c" }]);
  assert.deepEqual(tile.entity, { entity: "switch.pumpe", icon: "mdi:water-pump" });
  assert.deepEqual(glance.entities, [{ entity: "sensor.d", icon: "mdi:thermometer" }]);
});

test("Ansichten: Icon aus der Config nur in gültigem Format", () => {
  const d = convertDashboard({ views: [{ title: "Bad", icon: "mdi:shower" }, { title: "X", icon: "javascript:x" }, { title: "Y" }] }, "x");
  assert.deepEqual(d.views.map((v) => v.icon), ["mdi:shower", undefined, undefined]);
});
