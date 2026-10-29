// Accounts: one table, one row per account, expanding to its VPCs.
// Renders only from dashboard-data (data.accounts).

import { h, stmt, cap, withDef } from "./dom.js";

const SEV_ICON = { critical: "◆", high: "▲", medium: "●", low: "○" };
const ROLE_LABEL = { workload: "workload", load_balancer: "load balancer", nat_gateway: "NAT gateway", vpc_endpoint: "VPC endpoint", other: "other" };
const short = (az) => az.replace(/^.*\d/, "") || az;

const notInExport = (what) => h("p", { class: "nie" }, stmt("Not in export"), what ? ` ${what}` : null);

function count(v) {
  return v === null ? stmt("Not in export") : h("span", { class: "num" }, v);
}

function marker(row, onPick) {
  const hits = row.findingsBySeverity.filter((s) => s.count);
  if (!hits.length) return h("span", { class: "muted" }, "None");
  const words = hits.map((s) => `${s.count} ${s.severity}`).join(", ");
  return h("button", { type: "button", class: "sev-marker", "data-account": row.accountId,
    title: `${words}. Show in Findings.`, onclick: () => onPick(row.accountId) },
  hits.map((s) => h("span", { class: `sev sev-${s.severity}` },
    h("span", { "aria-hidden": "true" }, SEV_ICON[s.severity]), s.count, h("span", { class: "visually-hidden" }, ` ${s.severity}`))),
  h("span", { class: "visually-hidden" }, ". Show in Findings"));
}

function subnetTable(list) {
  if (!list.length) return h("p", { class: "muted small" }, "None");
  return h("table", { class: "mini" },
    h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "Address range"), h("th", null, "Zone"))),
    h("tbody", null, list.map((s) => h("tr", null, h("td", null, s.name || h("code", null, s.id)), h("td", null, h("code", null, s.cidr)), h("td", null, s.az)))));
}

function block(title, ...body) {
  return h("div", { class: "vpc-part" }, h("h5", null, title), body);
}

function vpc(n) {
  const head = h("header", { class: "vpc-head" },
    h("h4", null, n.name || (n.isDefault ? "Default VPC" : n.id)),
    n.cidrs.map((c) => h("code", { class: "cidr" }, c)),
    h("span", { class: "muted" }, [n.region, n.azs.length ? `zones ${n.azs.map(short).join(", ")}` : null, n.environment ? `Environment: ${n.environment}` : null].filter(Boolean).join(" · ")),
    h("code", { class: "muted small" }, n.id));

  const subnets = n.subnets === null
    ? [block("Subnets", notInExport())]
    : [block(`Public subnets (${n.subnets.public.length})`, subnetTable(n.subnets.public)),
       block(`Private subnets (${n.subnets.private.length})`, subnetTable(n.subnets.private)),
       n.subnets.unknown.length ? block("Public or private", notInExport("Route tables are missing, so this cannot be told."), subnetTable(n.subnets.unknown)) : null]
      .map((b) => b && (b.classList.add("subnets"), b));

  const routes = n.defaultRoutes === null
    ? block("Default routes", notInExport())
    : block("Default routes",
        n.defaultRoutes.routes.length
          ? h("ul", { class: "plain" }, n.defaultRoutes.routes.map((r) => h("li", null,
              h("code", null, r.destination), " → ", r.targetLabel, " ", r.target ? h("code", null, r.target) : null,
              h("div", { class: "muted small" }, r.subnets.length ? `Used by ${r.subnets.join(", ")}` : r.isMain ? "Main route table, no subnets use it" : "No subnets use it"))))
          : h("p", { class: "muted small" }, "No 0.0.0.0/0 route"),
        n.defaultRoutes.subnetsWithout?.length ? h("p", { class: "muted small" }, `No default route: ${n.defaultRoutes.subnetsWithout.join(", ")}`) : null);

  const endpoints = block("VPC endpoints",
    n.endpoints === null ? notInExport()
      : n.endpoints.length ? h("ul", { class: "plain" }, n.endpoints.map((e) => h("li", null, h("code", null, e.service), ` (${e.type})`)))
        : h("p", { class: "muted small" }, "None"));

  const nat = block("NAT gateways per zone",
    n.nat === null ? notInExport()
      : !n.nat.any ? h("p", { class: "muted small" }, "None")
        : h("ul", { class: "plain" },
            n.nat.perZone.map((z) => h("li", null, `${z.az}: `, z.gateways.length ? z.gateways.map((g) => h("code", null, g)) : h("span", { class: "muted" }, "none"))),
            n.nat.zoneUnknown.length ? h("li", null, "Zone unknown: ", n.nat.zoneUnknown.map((g) => h("code", null, g))) : null));

  const enis = block("Network interfaces",
    n.interfaces === null ? notInExport()
      : n.interfaces.length ? h("ul", { class: "plain" }, n.interfaces.map((r) => h("li", null, h("span", { class: "num" }, r.count), ` ${ROLE_LABEL[r.role]}`)))
        : h("p", { class: "muted small" }, "None"));

  return h("article", { class: "vpc", "data-vpc": n.id }, head, h("div", { class: "vpc-grid" }, subnets, routes, endpoints, nat, enis));
}

function detail(row) {
  return h("div", { class: "acct-body" },
    h("p", { class: "muted small" }, stmt("Observed"), " File ", h("code", null, row.file), " · Account ID ", h("code", null, row.accountId)),
    row.notInExport.length
      ? h("p", { class: "small" }, stmt("Not in export"), " ", row.notInExport.map((x) => x.what).join(", "))
      : null,
    row.networks.length ? row.networks.map(vpc)
      : row.vpcsNotInExportIn.length ? null : h("p", { class: "muted" }, "No VPCs in this file."));
}

export function renderAccounts(el, data, state, { onToggle, onPickAccount }) {
  const { columns, rows } = data.accounts;
  const n = columns.length;
  const head = h("tr", null, columns.map((c, i) =>
    h("th", { scope: "col", class: c.numeric ? "n" : null }, withDef(c.label, c.definition, i >= n - 3 ? "end" : "start"))));
  const body = rows.flatMap((r, i) => {
    const open = state.expanded.has(r.accountId);
    const id = `acct-detail-${i}`;
    return [
      h("tr", { class: `acct-row${open ? " open" : ""}` },
        h("th", { scope: "row" },
          h("button", { type: "button", class: "acct-toggle", "aria-expanded": String(open), "aria-controls": id, "data-account": r.accountId, onclick: () => onToggle(r.accountId) },
            h("span", { class: "chev", "aria-hidden": "true" }, "›"), h("span", null, r.name || r.accountId))),
        h("td", { "data-label": "Cloud" }, r.cloud.toUpperCase()),
        h("td", { "data-label": "Role" }, r.roleStatement === "Not in export" ? stmt("Not in export") : r.role || h("span", { class: "muted" }, "No AccountRole tag")),
        h("td", { "data-label": "Regions", class: "regions" }, r.regions.map((g, j) => [j ? ", " : null, h("span", { class: "nowrap" }, g)])),
        columns.filter((c) => c.numeric).map((c) => h("td", { class: "n", "data-label": c.label, "data-key": c.key }, count(r.counts[c.key]))),
        h("td", { "data-label": "Findings" }, marker(r, onPickAccount))),
      h("tr", { class: "acct-detail", id, hidden: !open }, h("td", { colspan: n }, open ? detail(r) : null)),
    ];
  });
  el.replaceChildren(
    h("div", { class: "table-scroll" }, h("table", { class: "accounts" }, h("thead", null, head), h("tbody", null, body))));
}
