// The `accounts` part of dashboard-data: one row per file (account, subscription or project)
// with per-account counts, findings by severity, and the per-VPC detail shown when a row expands.
// Company totals are not repeated here; they live in `overview`.
// A value is null where the section it needs is not in the export.

import { COUNTS } from "./model/counts.js";

const COLUMN_KEYS = ["vpcs", "subnets", "endpoints", "natGateways", "interfaces"];
const COUNT = Object.fromEntries(COUNTS.map((c) => [c.key, c]));
const WORLD = new Set(["0.0.0.0/0", "::/0"]);
const TARGET_LABEL = {
  internet: "internet gateway", nat: "NAT gateway", transit: "transit gateway", peering: "VPC peering",
  interface: "network interface", endpoint: "VPC endpoint", gateway: "gateway", local: "local", unknown: "unknown target",
};
const ROLES = ["workload", "load_balancer", "nat_gateway", "vpc_endpoint", "other"];

export const ACCOUNT_COLUMNS = [
  { key: "name", label: "Account", definition: "Account name and ID from the file. Select a row to see its VPCs." },
  { key: "cloud", label: "Cloud", definition: "Cloud provider, from the file's export schema." },
  { key: "role", label: "Role", definition: "The account's AccountRole tag (shared-network, prod, nonprod, data, security, sandbox)." },
  { key: "regions", label: "Regions", definition: "Region keys present in the file." },
  ...COLUMN_KEYS.map((k) => ({ key: k, label: COUNT[k].label, definition: COUNT[k].definition, numeric: true })),
  { key: "findings", label: "Findings", definition: "This account's findings by severity. Select to show them in Findings." },
];

function networkDetail(model, a, n) {
  const known = (key) => a.sections[n.region]?.[key] === true;
  const subnetsAll = model.subnets.filter((s) => s.networkId === n.id);
  const label = (s) => ({ id: s.id, name: s.name, cidr: s.cidr, az: s.az });

  let subnets = null;
  if (known("Subnets")) {
    subnets = {
      public: subnetsAll.filter((s) => s.public === true).map(label),
      private: subnetsAll.filter((s) => s.public === false).map(label),
      unknown: subnetsAll.filter((s) => s.public === null).map(label), // RouteTables not in export
    };
  }

  let defaultRoutes = null;
  if (known("RouteTables")) {
    const tables = model.routeTables.filter((rt) => rt.networkId === n.id);
    // One entry per destination and target; route tables that share a target are merged.
    const byTarget = new Map();
    for (const rt of tables) {
      for (const r of rt.routes.filter((x) => WORLD.has(x.destination))) {
        const key = `${r.destination}|${r.target}`;
        if (!byTarget.has(key)) {
          byTarget.set(key, {
            destination: r.destination, targetType: r.targetType,
            targetLabel: TARGET_LABEL[r.targetType] || r.targetType, target: r.target,
            routeTables: [], isMain: false, subnets: [],
          });
        }
        const e = byTarget.get(key);
        e.routeTables.push({ id: rt.id, name: rt.name });
        e.isMain = e.isMain || rt.isMain;
        e.subnets.push(...subnetsAll.filter((s) => s.routeTableId === rt.id).map((s) => s.name || s.id));
      }
    }
    const routes = [...byTarget.values()];
    const withDefault = new Set(tables.filter((rt) => rt.routes.some((r) => WORLD.has(r.destination))).map((rt) => rt.id));
    defaultRoutes = {
      routes,
      subnetsWithout: known("Subnets") ? subnetsAll.filter((s) => !withDefault.has(s.routeTableId)).map((s) => s.name || s.id) : null,
    };
  }

  const endpoints = known("VpcEndpoints")
    ? model.endpoints.filter((e) => e.networkId === n.id).map((e) => ({ id: e.id, service: e.serviceShort, type: e.type }))
    : null;

  let nat = null;
  if (known("NatGateways")) {
    const nats = model.gateways.filter((g) => g.kind === "nat" && g.networkIds.includes(n.id));
    nat = {
      perZone: n.azs.map((az) => ({ az, gateways: nats.filter((g) => g.az === az).map((g) => g.id) })),
      zoneUnknown: nats.filter((g) => !g.az || !n.azs.includes(g.az)).map((g) => g.id),
      any: nats.length > 0,
    };
  }

  let interfaces = null;
  if (known("NetworkInterfaces")) {
    const enis = model.interfaces.filter((e) => e.networkId === n.id);
    interfaces = ROLES.map((role) => ({ role, count: enis.filter((e) => e.role === role).length })).filter((r) => r.count);
  }

  return {
    id: n.id, name: n.name, region: n.region, cidrs: n.cidrs, isDefault: n.isDefault, azs: n.azs,
    environment: n.tags.Environment ?? null, src: n.src,
    subnets, defaultRoutes, endpoints, nat, interfaces,
  };
}

export function buildAccounts({ model, accts, summary, findings, severityOrder }) {
  const rows = accts.map((a) => {
    const counts = summary.accounts.find((r) => r.id === a.id).counts;
    const mine = findings.filter((f) => f.accountIds.includes(a.id));
    return {
      statement: "Observed",
      accountId: a.id, name: a.name, cloud: a.cloud, file: a.file,
      role: a.role, roleStatement: a.tags === null ? "Not in export" : "Observed",
      regions: a.regions,
      counts: Object.fromEntries(COLUMN_KEYS.map((k) => [k, counts[k]])),
      findingsBySeverity: severityOrder.map((s) => ({ severity: s, count: mine.filter((f) => f.severity === s).length })),
      vpcsNotInExportIn: a.regions.filter((r) => a.sections[r]?.Vpcs !== true),
      networks: model.networks.filter((n) => n.accountId === a.id).map((n) => networkDetail(model, a, n)),
      notInExport: model.notInExport.filter((x) => x.file === a.file).map((x) => ({ statement: "Not in export", path: x.path, what: x.what })),
    };
  });
  return { columns: ACCOUNT_COLUMNS, rows };
}
