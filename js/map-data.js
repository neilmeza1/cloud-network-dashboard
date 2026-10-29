// The `network_map` part of dashboard-data: the structure the Map draws, built from the files.
//   nodes:    one per VPC, with its worst finding
//   hubs:     transit gateways the VPCs attach to
//   edges:    internet (VPC has an internet gateway or an internet-facing load balancer),
//             transit (one per attachment id), peering (one per active peering id)
//   accounts: the boxes, with findings not tied to one VPC and sections not in the export
// Shared ids (attachments, peerings) are already de-duplicated by the model.

const MAP_SECTIONS = [
  ["Vpcs", "VPCs"], ["Subnets", "subnets"], ["InternetGateways", "internet gateways"],
  ["LoadBalancers", "load balancers"], ["TransitGatewayAttachments", "transit gateway attachments"],
  ["VpcPeeringConnections", "VPC peerings"],
];

export function buildNetworkMap({ model, accts, findings, severityOrder }) {
  const ids = new Set(accts.map((a) => a.id));
  const byId = new Map(accts.map((a) => [a.id, a]));
  const known = (a, region, key) => a.sections[region]?.[key] === true;
  const nets = model.networks.filter((n) => ids.has(n.accountId));
  const netIds = new Set(nets.map((n) => n.id));
  const bySeverity = (fs) => severityOrder.map((s) => ({ severity: s, count: fs.filter((f) => f.severity === s).length }));
  const worst = (fs) => severityOrder.find((s) => fs.some((f) => f.severity === s)) ?? null;
  const label = (n) => n.name || (n.isDefault ? `default (${n.id})` : n.id);

  const nodes = nets.map((n) => {
    const a = byId.get(n.accountId);
    const fs = findings.filter((f) => f.networkIds.includes(n.id));
    const subs = model.subnets.filter((s) => s.networkId === n.id);
    const igw = known(a, n.region, "InternetGateways")
      ? model.gateways.some((g) => g.kind === "internet" && g.networkIds.includes(n.id)) : null;
    const lb = known(a, n.region, "LoadBalancers")
      ? model.loadBalancers.some((l) => l.internetFacing && l.networkId === n.id) : null;
    return {
      id: n.id, accountId: n.accountId, label: label(n), name: n.name, isDefault: n.isDefault,
      cidrs: n.cidrs, region: n.region, azs: n.azs,
      subnets: known(a, n.region, "Subnets")
        ? { public: subs.filter((s) => s.public === true).length, private: subs.filter((s) => s.public === false).length,
            unknown: subs.filter((s) => s.public === null).length }
        : null,
      internet: { gateway: igw, publicLoadBalancer: lb },
      findingsBySeverity: bySeverity(fs), worst: worst(fs), externalPeerings: [],
    };
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const edges = [];
  for (const n of nodes) {
    const via = [n.internet.gateway && "internet gateway", n.internet.publicLoadBalancer && "internet-facing load balancer"].filter(Boolean);
    if (via.length) edges.push({ kind: "internet", id: `internet:${n.id}`, from: "internet", to: n.id, via });
  }

  // Transit hubs: gateways owned in these files, plus any gateway these VPCs attach to.
  const hubs = new Map();
  const hub = (tgwId) => {
    if (!hubs.has(tgwId)) {
      const g = model.gateways.find((x) => x.kind === "transit" && x.id === tgwId);
      const ownerId = g?.ownerId ?? model.transitAttachments.find((t) => t.transitGatewayId === tgwId)?.transitOwnerId ?? null;
      hubs.set(tgwId, {
        id: tgwId, name: g?.name ?? null, region: g?.region ?? null, ownerAccountId: ownerId,
        ownerName: byId.get(ownerId)?.name ?? null, inFiles: !!g && ids.has(g.accountId), externalAttachments: 0,
      });
    }
    return hubs.get(tgwId);
  };
  for (const g of model.gateways.filter((x) => x.kind === "transit" && ids.has(x.accountId))) hub(g.id);
  const mine = (t) => t.networkId && netIds.has(t.networkId);
  for (const t of model.transitAttachments.filter(mine)) {
    hub(t.transitGatewayId);
    edges.push({ kind: "transit", id: t.id, from: t.networkId, to: t.transitGatewayId, state: t.state });
  }
  for (const t of model.transitAttachments.filter((x) => !mine(x) && hubs.has(x.transitGatewayId))) {
    hubs.get(t.transitGatewayId).externalAttachments++; // attaches a VPC from a file not loaded
  }

  for (const p of model.peerings.filter((x) => x.active)) {
    const a = p.requester.networkId, b = p.accepter.networkId;
    if (netIds.has(a) && netIds.has(b)) {
      edges.push({ kind: "peering", id: p.id, from: a, to: b });
    } else if (netIds.has(a) || netIds.has(b)) {
      const [mine, other] = netIds.has(a) ? [p.requester, p.accepter] : [p.accepter, p.requester];
      nodeById.get(mine.networkId).externalPeerings.push({ id: p.id, networkId: other.networkId, accountId: other.accountId, region: other.region });
    }
  }

  const accounts = accts.map((a) => {
    const own = findings.filter((f) => f.accountIds.includes(a.id) && !f.networkIds.length);
    const notInExport = MAP_SECTIONS.map(([key, text]) => {
      const regions = a.regions.filter((r) => !known(a, r, key));
      return regions.length ? { section: key, label: text, regions } : null;
    }).filter(Boolean);
    return {
      accountId: a.id, name: a.name || a.id, role: a.role, roleStatement: a.tags === null ? "Not in export" : "Observed",
      regions: a.regions,
      networkIds: nodes.filter((n) => n.accountId === a.id).map((n) => n.id),
      accountFindingsBySeverity: bySeverity(own), notInExport,
    };
  });

  const missingInternet = accounts.filter((a) => a.notInExport.some((x) => x.section === "InternetGateways" || x.section === "LoadBalancers"));
  return {
    statement: "Observed",
    internet: { notInExportIn: missingInternet.map((a) => a.name) },
    accounts, nodes, hubs: [...hubs.values()], edges,
  };
}
