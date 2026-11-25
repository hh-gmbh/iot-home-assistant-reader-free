// Markdown → HTML für Markdown-Karten. Zwei Stufen:
//  1. marked: rohes HTML im Markdown wird nicht übernommen (Tags entfernt, Text bleibt, escaped).
//     Einzige Ausnahme: <ha-icon icon="mdi:name"> mit genau diesem einen Attribut – es wird in
//     einer selbst erzeugten Normalform wieder ausgegeben.
//  2. DOMPurify: nur eine feste Liste harmloser Tags/Attribute, keine Bilder, keine Skripte.
//     ha-icon nur mit gültigem icon und ohne weitere Attribute, sonst wird es entfernt.
// Die Bibliotheken werden übergeben, damit sich die Funktionen auch ohne Browser testen lassen.

export const ICON_NAME = /^mdi:[a-z0-9-]+$/;

export const ALLOWED_TAGS = [
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "em", "del", "code", "pre", "blockquote",
  "ul", "ol", "li", "a",
  "table", "thead", "tbody", "tr", "th", "td",
  "ha-icon",
];
export const ALLOWED_ATTR = ["href", "title", "align", "icon"];

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// <ha-icon icon="mdi:x">, <ha-icon icon='mdi:x'/>, <ha-icon icon=mdi:x> – nichts sonst im Tag
const HA_ICON_TAG = /^<ha-icon\s+icon\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`\/]+))\s*\/?>$/i;

function convertTag(tag) {
  const m = HA_ICON_TAG.exec(tag);
  if (!m) return ""; // jedes andere Tag (auch </ha-icon>) fällt weg
  const name = m[1] ?? m[2] ?? m[3];
  return ICON_NAME.test(name) ? `<ha-icon icon="${name}"></ha-icon>` : "";
}

/** Rohes HTML: Tags (und Kommentare) weg, Text escaped; gültige ha-icon bleiben (Normalform). */
export function stripHtml(raw) {
  const s = raw
    .replace(/<(script|style|iframe|object|embed|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  let out = "";
  let last = 0;
  for (const m of s.matchAll(/<\/?[^>]*>?/g)) {
    out += escapeHtml(s.slice(last, m.index)) + convertTag(m[0]);
    last = m.index + m[0].length;
  }
  return out + escapeHtml(s.slice(last));
}

/** Liefert eine Funktion markdown → HTML-String (noch nicht sanitisiert). */
export function createMarkdown(Marked) {
  const md = new Marked({ gfm: true, breaks: true, async: false });
  md.use({
    renderer: {
      html: ({ text }) => stripHtml(text),
      image: ({ text }) => escapeHtml(text ?? ""), // keine Bilder (würden fremde Server anfragen)
    },
  });
  return (src) => md.parse(String(src ?? ""));
}

export const SANITIZE = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/)/i,
  // "mdi:fire" ist keine URL; geprüft wird icon im Hook unten (nur ha-icon, nur ICON_NAME)
  ADD_URI_SAFE_ATTR: ["icon"],
  RETURN_DOM_FRAGMENT: true,
};

const prepared = new WeakSet();

/** Regeln für ha-icon und Links einmal je DOMPurify-Instanz einhängen. */
export function preparePurify(purify) {
  if (prepared.has(purify)) return purify;
  prepared.add(purify);
  purify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName !== "ha-icon") return;
    const attrs = [...node.attributes];
    const ok = attrs.length === 1 && attrs[0].name === "icon" && ICON_NAME.test(attrs[0].value);
    // ungültig: alle Attribute weg, danach wird das Element unten entfernt
    if (!ok) for (const a of attrs) node.removeAttribute(a.name);
  });
  purify.addHook("uponSanitizeAttribute", (node, data) => {
    // icon nur an ha-icon, und nur gültig
    if (data.attrName === "icon" && !(node.nodeName === "HA-ICON" && ICON_NAME.test(data.attrValue))) data.keepAttr = false;
  });
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A" && node.getAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  return purify;
}

/** HTML-String → bereinigtes DocumentFragment (ha-icon ohne gültiges icon entfernt, immer leer). */
export function sanitizeHtml(html, purify) {
  const frag = preparePurify(purify).sanitize(html, SANITIZE);
  for (const el of frag.querySelectorAll("ha-icon")) {
    if (!ICON_NAME.test(el.getAttribute("icon") ?? "")) el.remove();
    else el.replaceChildren();
  }
  return frag;
}

const cache = new WeakMap();

/** Markdown → bereinigtes DocumentFragment. purify = DOMPurify-Instanz. */
export function renderMarkdown(src, Marked, purify) {
  let toHtml = cache.get(Marked);
  if (!toHtml) cache.set(Marked, (toHtml = createMarkdown(Marked)));
  return sanitizeHtml(toHtml(src), purify);
}
