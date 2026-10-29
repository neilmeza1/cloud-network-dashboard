// Overview: one scope line, five count tiles and the findings-by-severity tile.
// Renders only from dashboard-data (data.overview).

import { h, stmt, sevBadge } from "./dom.js";

const date = (iso) => (iso || "").slice(0, 10);

function value(item) {
  if (item.value === null) return stmt("Not in export");
  return h("span", { class: "num" }, item.value, item.notInExportIn.length ? "*" : "");
}

function partialNote(items) {
  const files = [...new Set(items.flatMap((i) => i.notInExportIn))];
  if (!files.length) return null;
  return h("p", { class: "tile-note" }, "* Not in export in ", files.map((f) => f.split("/").pop()).join(", "), ", so the total leaves it out.");
}

function tile(t, i) {
  const defId = `tile-def-${i}`;
  const [first, ...rest] = t.items;
  const body = t.layout === "primary"
    ? [h("p", { class: "big", title: first.definition }, value(first)),
       rest.length ? h("ul", { class: "tile-sub" }, rest.map((it) => h("li", { title: it.definition }, value(it), " ", it.label))) : null]
    : [h("ul", { class: "tile-list" }, t.items.map((it) => h("li", { title: it.definition }, value(it), " ", it.label)))];
  return h("li", { class: "tile", tabindex: "0", "aria-describedby": defId },
    h("div", { class: "tile-head" }, h("h3", { class: "tile-label" }, t.label, h("span", { class: "hint", "aria-hidden": "true" }, "?")), stmt("Observed")),
    body,
    t.note ? h("p", { class: "tile-note" }, t.note) : null,
    partialNote(t.items),
    h("p", { class: "tile-def", id: defId, role: "tooltip" }, t.definition));
}

function severityTile(s, onPick) {
  const total = s.counts.reduce((n, c) => n + c.count, 0);
  return h("li", { class: "tile tile-sev", tabindex: "0", "aria-describedby": "tile-def-sev" },
    h("div", { class: "tile-head" }, h("h3", { class: "tile-label" }, "Findings by severity", h("span", { class: "hint", "aria-hidden": "true" }, "?")), stmt("Finding")),
    total
      ? h("div", { class: "sevbar", "aria-hidden": "true" },
          s.counts.filter((c) => c.count).map((c) => h("span", { class: `seg seg-${c.severity}`, style: `flex-grow:${c.count}` })))
      : h("p", { class: "tile-note" }, "No checks failed."),
    h("ul", { class: "sev-rows" }, s.counts.map((c) =>
      h("li", null, h("button", { type: "button", class: "sev-row", title: `${c.meaning}. Show these in Findings.`, onclick: () => onPick(c.severity) },
        sevBadge(c.severity), h("span", { class: "num" }, c.count))))),
    h("p", { class: "tile-def", id: "tile-def-sev", role: "tooltip" }, s.definition, " Select a severity to filter Findings."));
}

export function renderOverview(el, data, { onPickSeverity }) {
  const ov = data.overview;
  const sc = ov.scope;
  const az = sc.availabilityZones;
  const scope = h("p", { class: "scope" }, stmt("Observed"), " ",
    h("strong", null, sc.company), ": regions ", sc.regions.join(", "), ", across ",
    az.value === null ? "an unknown number of" : az.value, " availability zones (AZs, separate data center buildings within a region)",
    sc.exportsGenerated.length ? `. Exports generated ${[...new Set(sc.exportsGenerated.map(date))].join(", ")}.` : ".");
  el.replaceChildren(scope, h("ul", { class: "tiles" }, ov.tiles.map(tile), severityTile(ov.findingsBySeverity, onPickSeverity)));
}
