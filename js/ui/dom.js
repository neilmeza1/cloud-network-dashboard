// Small DOM helpers. All text from uploaded files goes in as text nodes, never as HTML.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// "Observed" | "Finding" | "Not in export". Told apart by wording and border style, not color.
export function stmt(statement) {
  const slug = statement.toLowerCase().replace(/\s+/g, "-");
  return h("span", { class: `stmt stmt-${slug}` }, statement);
}

const SEV_ICON = { critical: "◆", high: "▲", medium: "●", low: "○" };

// Severity is the only thing shown in color, and always with an icon and the word.
export function sevBadge(sev) {
  return h("span", { class: `sev sev-${sev}` }, h("span", { class: "sev-icon", "aria-hidden": "true" }, SEV_ICON[sev] || "•"), cap(sev));
}

// A rendered count, tagged with the fact it shows so tests can check each fact has one home.
export function num(value, fact, cls = "num") {
  return h("span", { class: cls, "data-count": fact }, value);
}

// A label with a one-line definition shown on hover or keyboard focus.
let defSeq = 0;
export function withDef(label, definition, align = "start") {
  const id = `def-${++defSeq}`;
  return h("span", { class: `has-def def-${align}`, tabindex: "0", "aria-describedby": id },
    label, h("span", { class: "def-pop", id, role: "tooltip" }, definition));
}

export function clear(el, ...kids) {
  el.replaceChildren();
  for (const k of kids.flat(Infinity)) if (k) el.append(k);
  return el;
}
