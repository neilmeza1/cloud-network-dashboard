// Map: inline SVG drawn from data.network_map, laid out by layoutMap(). No libraries.
// Severity is shown as a colored outline plus an icon; everything else is neutral.

import { h, stmt, clear, num } from "./dom.js";
import { layoutMap } from "../map-layout.js";

const NS = "http://www.w3.org/2000/svg";
const SEV_ICON = { critical: "◆", high: "▲", medium: "●", low: "○" };

function s(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v);
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const trunc = (t, n) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
const sevWords = (list) => list.filter((x) => x.count).map((x) => `${x.count} ${x.severity}`).join(", ");

function tooltip(n, data) {
  const acct = data.network_map.accounts.find((a) => a.accountId === n.accountId);
  const f = (k) => `vpc.${n.id}.${k}`;
  const split = n.subnets && n.subnets.public + n.subnets.private > 0;
  const subs = n.subnets === null ? stmt("Not in export")
    : !split && n.subnets.unknown
      ? [num(n.subnets.unknown, f("subnets.unknown"), null), " (public or private: ", stmt("Not in export"), ")"]
      : [num(n.subnets.public, f("subnets.public"), null), " public, ", num(n.subnets.private, f("subnets.private"), null), " private",
         n.subnets.unknown ? [", ", num(n.subnets.unknown, f("subnets.unknown"), null), " unknown"] : null];
  const internet = [n.internet.gateway && "internet gateway", n.internet.publicLoadBalancer && "internet-facing load balancer"].filter(Boolean);
  const hits = n.findingsBySeverity.filter((x) => x.count);
  return [
    h("p", { class: "tip-title" }, `${n.kind} ${n.label}`),
    h("dl", null,
      h("dt", null, "Address range"), h("dd", null, n.cidrs.length ? n.cidrs.join(", ") : "none", n.cidrSource === "subnets" ? " (from its subnets)" : ""),
      h("dt", null, "Account"), h("dd", null, acct?.name ?? n.accountId),
      h("dt", null, "Region"), h("dd", null, n.region === "global" && n.subnetRegions.length ? `global (subnets in ${n.subnetRegions.join(", ")})` : n.region),
      h("dt", null, "Zones"), h("dd", null, !n.zonesKnown ? stmt("Not in export") : n.azs.length ? n.azs.join(", ") : "none"),
      h("dt", null, "Subnets"), h("dd", null, subs),
      internet.length ? [h("dt", null, "Internet"), h("dd", null, internet.join(", "))] : null,
      n.externalPeerings.length ? [h("dt", null, "Peered with"), h("dd", null, n.externalPeerings.map((p) => `${p.networkId} (not in these files)`).join(", "))] : null,
      h("dt", null, "Findings"),
      h("dd", null, hits.length
        ? hits.map((x) => h("span", { class: `sev sev-${x.severity} tip-sev` }, h("span", { "aria-hidden": "true" }, SEV_ICON[x.severity]),
            num(x.count, f(`findings.${x.severity}`), null), ` ${x.severity}`))
        : "none")),
    h("p", { class: "tip-hint" }, hits.length ? "Select to show this account's findings." : "Select to show this account in Findings."),
  ];
}

export function renderMap(el, data, { onPickAccount }) {
  const map = data.network_map;
  if (!map.nodes.length && !map.accounts.some((a) => a.notInExport.length)) {
    el.replaceChildren(h("p", { class: "empty" }, "No networks in these files."));
    return;
  }
  const L = layoutMap(map);
  const nodeData = new Map(map.nodes.map((n) => [n.id, n]));
  const acctData = new Map(map.accounts.map((a) => [a.accountId, a]));

  const svg = s("svg", { class: "map-svg", width: L.width, height: L.height, viewBox: `0 0 ${L.width} ${L.height}`, role: "group",
    "aria-label": "Network map: accounts, their networks, the internet edge, transit hubs and peerings" });

  // Internet edge
  const ie = L.internet;
  svg.append(s("g", { class: "internet" },
    s("rect", { class: "internet-box", x: ie.x, y: ie.y, width: ie.w, height: ie.h, rx: 8 }),
    s("text", { x: ie.x + 14, y: ie.y + 22, class: "t-strong" }, "Internet"),
    map.internet.notInExportIn.length
      ? s("text", { x: ie.x + ie.w - 12, y: ie.y + 22, class: "t-small t-nie", "text-anchor": "end" },
          s("title", null, `Internet gateways or load balancers not in export for ${map.internet.notInExportIn.join(", ")}`),
          trunc(`Not in export for ${map.internet.notInExportIn.join(", ")}`, Math.floor((ie.w - 90) / 6.2)))
      : null));

  // Account boxes
  for (const b of L.boxes) {
    const a = acctData.get(b.accountId);
    const own = a.accountFindingsBySeverity.filter((x) => x.count);
    const role = a.roleStatement === "Not in export" ? "role not in export" : a.role || "no AccountRole tag";
    const g = s("g", { class: "acct" },
      s("rect", { class: "acct-box", x: b.x, y: b.y, width: b.w, height: b.h, rx: 10 }),
      s("text", { x: b.x + 10, y: b.y + 19, class: "t-strong" }, s("title", null, a.name), trunc(a.name, own.length ? 15 : 25)),
      s("text", { x: b.x + 10, y: b.y + 35, class: "t-small t-muted" }, trunc(role, 30)));
    if (own.length) {
      const marker = s("g", { class: "acct-marker", tabindex: "0", role: "button", "data-account": a.accountId,
        "aria-label": `${a.name}: ${sevWords(own)} not tied to one network. Show this account's findings.` },
      s("title", null, `${sevWords(own)} not tied to one network (account or region). Select to show this account's findings.`),
      s("rect", { class: "marker-hit", x: b.x + b.w - 74, y: b.y + 5, width: 68, height: 20, rx: 4 }),
      s("text", { x: b.x + b.w - 10, y: b.y + 19, "text-anchor": "end", class: "t-small" },
        own.map((x, i) => [
          s("tspan", { class: `sev-${x.severity} t-sev`, dx: i ? 6 : 0 }, SEV_ICON[x.severity]),
          s("tspan", { class: `sev-${x.severity} t-sev`, "data-count": `account.${a.accountId}.unscopedFindings.${x.severity}` }, x.count)])));
      const pick = () => onPickAccount(a.accountId);
      marker.addEventListener("click", pick);
      marker.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
      g.append(marker);
    }
    let fy = b.y + b.h - 10 - (a.notInExport.length - 1) * 15;
    if (!a.networkIds.length && !a.notInExport.some((x) => x.section === "Vpcs")) {
      g.append(s("text", { x: b.x + 10, y: b.y + 60, class: "t-small t-muted" }, "No networks"));
    }
    for (const x of a.notInExport) {
      const text = `${x.label}: not in export${x.regions.length ? ` (${x.regions.join(", ")})` : ""}`;
      g.append(s("text", { x: b.x + 10, y: fy, class: "t-small t-nie" }, s("title", null, text), trunc(text, 32)));
      fy += 15;
    }
    svg.append(g);
  }

  // Edges under nodes
  const edgeLayer = s("g", { class: "edges" });
  for (const e of L.edges) {
    edgeLayer.append(s("path", { class: `edge edge-${e.kind}`, "data-from": e.from, "data-to": e.to, "data-id": e.id,
      d: "M" + e.points.map((p) => p.join(" ")).join(" L") }));
  }
  svg.append(edgeLayer);

  // Transit hubs
  for (const hb of L.hubs) {
    const sub = [hb.name || hb.id, hb.region].filter(Boolean).join(" · ");
    const title = [`Transit gateway ${hb.id}`, hb.ownerName ? `owned by ${hb.ownerName}` : hb.inFiles ? null : "owner's file not loaded",
      hb.externalAttachments ? `${hb.externalAttachments} attachments from files not loaded` : null].filter(Boolean).join(", ");
    svg.append(s("g", { class: "hub", "data-hub": hb.id },
      s("title", null, title),
      s("rect", { class: "hub-box", x: hb.x, y: hb.y, width: hb.w, height: hb.h, rx: hb.h / 2 }),
      s("text", { x: hb.x + hb.w / 2, y: hb.y + 18, "text-anchor": "middle", class: "t-strong t-small" }, "Transit hub"),
      s("text", { x: hb.x + hb.w / 2, y: hb.y + 33, "text-anchor": "middle", class: "t-small t-muted" }, trunc(sub, 28))));
  }

  // Network nodes
  const tip = h("div", { class: "map-tip", role: "tooltip", id: "map-tip", hidden: true });
  const scroller = h("div", { class: "map-scroll", tabindex: "-1" }, svg, tip);
  const highlight = (id, on) => {
    for (const p of edgeLayer.querySelectorAll("path")) {
      if (p.dataset.from === id || p.dataset.to === id) p.classList.toggle("hl", on);
    }
  };
  const show = (g, n) => {
    tip.replaceChildren(...tooltip(n, data));
    tip.hidden = false;
    const r = g.getBoundingClientRect(), c = scroller.getBoundingClientRect();
    const left = Math.min(r.left - c.left + scroller.scrollLeft, scroller.scrollWidth - tip.offsetWidth - 4);
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${r.bottom - c.top + scroller.scrollTop + 6}px`;
    highlight(n.id, true);
  };
  const hide = (n) => { tip.hidden = true; highlight(n.id, false); };

  for (const box of L.nodes) {
    const n = nodeData.get(box.id);
    const line2 = `${n.cidrs[0] || "no address range"}${n.cidrs.length > 1 ? ` +${n.cidrs.length - 1}` : ""} · ${n.region}`;
    const g = s("g", {
      class: `node${n.worst ? ` worst-${n.worst}` : ""}`, tabindex: "0", role: "button", "data-vpc": n.id, "data-account": n.accountId,
      "aria-describedby": "map-tip",
      "aria-label": `${n.kind} ${n.label}, ${n.cidrs.join(", ") || "no address range"}, ${n.region}. ${n.worst ? `Worst finding: ${n.worst}.` : "No findings."} Show this account's findings.`,
    },
    s("rect", { class: "focus-ring", x: box.x - 4, y: box.y - 4, width: box.w + 8, height: box.h + 8, rx: 9 }),
    s("rect", { class: "node-box", x: box.x, y: box.y, width: box.w, height: box.h, rx: 6 }),
    s("text", { x: box.x + 10, y: box.y + 19, class: "t-strong t-node" }, trunc(n.label, n.worst ? 19 : 22)),
    s("text", { x: box.x + 10, y: box.y + 36, class: "t-mono t-muted" }, trunc(line2, 25)),
    n.worst ? s("text", { x: box.x + box.w - 13, y: box.y + 19, "text-anchor": "middle", class: `sev-${n.worst} t-sev sev-icon-map` }, SEV_ICON[n.worst]) : null);
    const pick = () => onPickAccount(n.accountId);
    g.addEventListener("click", pick);
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
      if (e.key === "Escape") hide(n);
    });
    g.addEventListener("mouseenter", () => show(g, n));
    g.addEventListener("mouseleave", () => hide(n));
    g.addEventListener("focus", () => show(g, n));
    g.addEventListener("blur", () => hide(n));
    svg.append(g);
  }

  const missing = map.accounts.filter((a) => a.notInExport.length);
  const line = (cls, text) => h("li", { class: "legend-line" }, h("span", { class: `swatch ${cls}`, "aria-hidden": "true" }), h("span", null, text));
  const legend = h("ul", { class: "map-legend" },
    line("line-internet", "Internet path (internet gateway or internet-facing load balancer)"),
    line("line-transit", "Transit gateway attachment"),
    line("line-peering", "Network peering"),
    h("li", null, stmt("Finding"), "Outline and icon show a network's worst finding:",
      ["critical", "high", "medium", "low"].map((sv) => h("span", { class: `sev sev-${sv} legend-sev` }, h("span", { "aria-hidden": "true" }, SEV_ICON[sv]), sv)),
      h("span", null, "A marker next to an account name counts findings not tied to one network.")));

  const hint = h("p", { class: "map-hint", hidden: true }, "Scroll sideways inside the map to see every account.");
  clear(el,
    h("p", { class: "map-intro" }, stmt("Observed"), " Accounts, networks and connections as listed in the files. Hover or focus a network for details; select it to show its account's findings."),
    missing.length
      ? h("p", { class: "note" }, stmt("Not in export"), " ", missing.map((a) => `${a.name}: ${a.notInExport.map((x) => `${x.label}${x.regions.length ? ` (${x.regions.join(", ")})` : ""}`).join(", ")}`).join("; "))
      : null,
    hint, scroller, legend);
  const fits = () => { hint.hidden = scroller.scrollWidth <= scroller.clientWidth + 1; };
  requestAnimationFrame(fits);
  if (el.mapFits) window.removeEventListener("resize", el.mapFits);
  el.mapFits = fits;
  window.addEventListener("resize", fits);
}
