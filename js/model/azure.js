// Azure normalizer: one `azure-subscription-inventory/1.0` file -> one model fragment,
// the same shape the AWS normalizer produces. Every record keeps `src: { file, path }`.
//
// Closest equivalents (samples/README.md):
//   subscription -> account, VNet -> network, NSG -> security group (Allow rules only),
//   application gateway -> load balancer (WAF signal: WAF SKU or a firewall policy),
//   private endpoint -> endpoint, flow log on a VNet -> flow log.
// The format has no route tables, internet gateways, network interfaces, listeners,
// transit hubs, zones or CDN, so those concepts are recorded as not in export.

import { emptyFragment } from "./aws.js";
import { fileSections, getTag } from "./concepts.js";

const FORMAT = {
  Vpcs: "$.VirtualNetworks", Subnets: "$.VirtualNetworks", NetworkTags: "$.VirtualNetworks",
  VpcPeeringConnections: "$.VirtualNetworks", NatGateways: "$.NatGateways", VpcEndpoints: "$.PrivateEndpoints",
  SecurityGroups: "$.NetworkSecurityGroups", FlowLogs: "$.FlowLogs",
  LoadBalancers: "$.ApplicationGateways", WebAclResources: "$.ApplicationGateways",
};
const WORLD = new Set(["*", "internet", "any", "0.0.0.0/0", "::/0"]);
const lower = (s) => String(s ?? "").toLowerCase();
const vnetOf = (subnetId) => (subnetId || "").split("/subnets/")[0] || null;

function portRange(p) {
  if (p === undefined || p === null || p === "*") return [0, 65535];
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(p).trim());
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
}

export function normalizeAzure(doc, meta) {
  const file = meta.path || meta.file;
  const out = emptyFragment();
  const src = (path) => ({ file, path });
  const list = (key) => (Array.isArray(doc[key]) ? doc[key] : []);

  const sub = doc.Subscription || null;
  if (!sub) out.notInExport.push({ file, path: "$.Subscription", what: "Subscription section" });
  const accountId = sub?.subscriptionId || `unknown:${file}`;
  const tags = sub?.tags ?? null;
  if (sub && !sub.tags) out.notInExport.push({ file, path: "$.Subscription.tags", what: "Subscription tags" });

  // Regions: every location a resource names, with the first place it is named as evidence.
  const regionSrc = {};
  const seeLocation = (loc, path) => { if (loc && !(loc in regionSrc)) regionSrc[loc] = `${path}.location`; };
  for (const key of ["VirtualNetworks", "NetworkSecurityGroups", "ApplicationGateways", "NatGateways", "PrivateEndpoints", "PublicIPAddresses", "FlowLogs"]) {
    list(key).forEach((r, i) => seeLocation(r.location, `$.${key}[${i}]`));
  }
  const regions = Object.keys(regionSrc);
  const { sections, sectionPaths, notInExport } = fileSections(doc, FORMAT, regions, file);
  out.notInExport.push(...notInExport);

  out.accounts.push({
    cloud: "azure", id: accountId, name: sub?.displayName || accountId, company: meta.folder || null,
    exportCompany: null, dir: meta.dir ?? null, file, tags, role: getTag(tags, "AccountRole"),
    environment: getTag(tags, "Environment"), regions, sections, sectionPaths,
    tagsPath: "$.Subscription.tags", regionSrc, src: src("$.Subscription"),
  });
  const base = (region) => ({ cloud: "azure", accountId, region });

  // NSG and NAT gateway attachment comes from the subnets that reference them.
  const nsgNetwork = new Map();
  const natUse = new Map();
  const vnets = list("VirtualNetworks");
  vnets.forEach((v, i) => {
    const vt = v.tags || {};
    out.networks.push({
      ...base(v.location), id: v.id, name: v.name ?? null, kind: "VNet", cidrs: v.addressSpace?.addressPrefixes || [],
      isDefault: false, state: null, tags: vt, tagsPath: `$.VirtualNetworks[${i}].tags`, flowLogScope: "network",
      azs: [], src: src(`$.VirtualNetworks[${i}]`),
    });
    (v.subnets || []).forEach((s, j) => {
      out.subnets.push({
        ...base(v.location), id: s.id, networkId: v.id, name: s.name ?? null, tier: null,
        cidr: s.addressPrefix ?? s.addressPrefixes?.[0] ?? null, az: null, mapPublicIp: false,
        routeTableId: null, public: null, src: src(`$.VirtualNetworks[${i}].subnets[${j}]`),
      });
      if (s.networkSecurityGroup?.id && !nsgNetwork.has(lower(s.networkSecurityGroup.id))) nsgNetwork.set(lower(s.networkSecurityGroup.id), v.id);
      if (s.natGateway?.id) {
        const k = lower(s.natGateway.id);
        if (!natUse.has(k)) natUse.set(k, { networkIds: new Set(), subnetId: s.id });
        natUse.get(k).networkIds.add(v.id);
      }
    });
    // Each side of a peering lists its own object; the pair of VNet ids identifies it once.
    (v.virtualNetworkPeerings || []).forEach((p, j) => {
      const remote = p.remoteVirtualNetwork?.id ?? null;
      if (!remote) return;
      const remoteSub = /\/subscriptions\/([^/]+)/i.exec(remote)?.[1] ?? null;
      out.peerings.push({
        cloud: "azure", id: [lower(v.id), lower(remote)].sort().join("|"), status: p.peeringState ?? null,
        active: lower(p.peeringState) === "connected",
        requester: { accountId, networkId: v.id, cidr: (v.addressSpace?.addressPrefixes || [])[0] ?? null, region: v.location },
        accepter: { accountId: remoteSub, networkId: remote, cidr: p.remoteAddressSpace?.addressPrefixes?.[0] ?? null, region: null },
        seenIn: [src(`$.VirtualNetworks[${i}].virtualNetworkPeerings[${j}]`)], src: src(`$.VirtualNetworks[${i}].virtualNetworkPeerings[${j}]`),
      });
    });
  });

  list("NatGateways").forEach((g, i) => {
    const use = natUse.get(lower(g.id));
    out.gateways.push({
      ...base(g.location), kind: "nat", id: g.id ?? g.name, name: g.name ?? null,
      networkIds: use ? [...use.networkIds] : [], subnetId: use?.subnetId ?? null, az: null, state: null,
      src: src(`$.NatGateways[${i}]`),
    });
  });

  list("PrivateEndpoints").forEach((e, i) => {
    out.endpoints.push({
      ...base(e.location), id: e.id ?? e.name, networkId: vnetOf(e.subnet?.id), service: e.privateLinkServiceConnections?.[0]?.groupIds?.[0] ?? null,
      serviceShort: e.privateLinkServiceConnections?.[0]?.groupIds?.[0] ?? null, type: "private", state: null,
      src: src(`$.PrivateEndpoints[${i}]`),
    });
  });

  list("NetworkSecurityGroups").forEach((g, i) => {
    const networkId = nsgNetwork.get(lower(g.id)) ?? null;
    out.securityGroups.push({
      ...base(g.location), id: g.id ?? g.name, networkId, groupName: g.name, name: g.name, kind: "network security group",
      description: null, src: src(`$.NetworkSecurityGroups[${i}]`),
    });
    (g.securityRules || []).forEach((r, j) => {
      if (lower(r.access) !== "allow") return; // deny rules open nothing
      const proto = lower(r.protocol);
      const ports = [r.destinationPortRange, ...(r.destinationPortRanges || [])].filter((p) => p !== undefined).map(portRange).filter(Boolean);
      const sources = [r.sourceAddressPrefix, ...(r.sourceAddressPrefixes || [])].filter((x) => x !== undefined && x !== null);
      for (const [lo, hi] of ports.length ? ports : [[0, 65535]]) {
        const allPorts = lo === 0 && hi === 65535;
        const protocol = proto === "*" ? (allPorts ? "all" : "any") : proto;
        for (const s of sources) {
          out.firewallRules.push({
            ...base(g.location), groupId: g.id ?? g.name, groupName: g.name, groupKind: "network security group", networkId,
            direction: lower(r.direction) === "outbound" ? "egress" : "ingress", protocol, fromPort: lo, toPort: hi,
            source: { kind: "cidr", value: s }, fromWorld: WORLD.has(lower(s)),
            src: src(`$.NetworkSecurityGroups[${i}].securityRules[${j}]`),
          });
        }
      }
    });
  });

  list("ApplicationGateways").forEach((a, i) => {
    const sku = a.sku?.tier || a.sku?.name || null;
    const subnetId = a.gatewayIPConfigurations?.[0]?.subnet?.id ?? null;
    out.loadBalancers.push({
      ...base(a.location), id: a.id ?? a.name, name: a.name ?? null, type: "application gateway", kind: "application gateway",
      scheme: null, internetFacing: (a.frontendIPConfigurations || []).some((f) => f.publicIPAddress),
      networkId: vnetOf(subnetId), azs: [], dnsName: null, sku,
      // WAF signal: a WAF SKU or an attached firewall policy; no SKU field means the export cannot say
      wafAclArn: a.firewallPolicy?.id || (sku && /^waf/i.test(sku) ? `sku:${sku}` : (sku ? null : undefined)),
      src: src(`$.ApplicationGateways[${i}]`),
    });
  });

  list("FlowLogs").forEach((f, i) => {
    out.flowLogs.push({
      ...base(f.location), id: f.id ?? f.name, resourceId: f.targetResourceId ?? null, status: f.enabled ? "enabled" : "disabled",
      active: f.enabled === true, trafficType: null, destination: null, src: src(`$.FlowLogs[${i}]`),
    });
  });

  return out;
}
