// GCP normalizer: one `gcp-project-inventory/1.0` file -> one model fragment,
// the same shape the AWS normalizer produces. Every record keeps `src: { file, path }`.
//
// Closest equivalents (samples/README.md):
//   project -> account, VPC network -> network (global; its address ranges are its subnets'),
//   firewall rule -> security group with its own rules (enabled allow rules only),
//   backend service -> load balancer (WAF signal: a Cloud Armor security policy),
//   subnet logConfig -> flow log, set per subnet, Cloud NAT -> NAT gateway.
// The network named "default" is GCP's default network.
// The format has no route tables, internet gateways, network interfaces, private endpoints,
// listeners linked to a backend, transit hubs, zones, CDN or labels on networks, so those
// concepts are recorded as not in export. A network with no `peerings` field has none:
// gcloud leaves the field out when the list is empty.

import { emptyFragment } from "./aws.js";
import { fileSections, getTag } from "./concepts.js";

const FORMAT = {
  Vpcs: "$.Networks", VpcPeeringConnections: "$.Networks", Subnets: "$.Subnetworks", FlowLogs: "$.Subnetworks",
  SecurityGroups: "$.Firewalls", NatGateways: "$.RouterNats",
  LoadBalancers: "$.BackendServices", WebAclResources: "$.BackendServices", WebAcls: "$.SecurityPolicies",
};
const WORLD = new Set(["0.0.0.0/0", "::/0"]);
const last = (url) => String(url ?? "").split("/").filter(Boolean).pop() ?? null;
// projects/<project>/global/networks/<name> from a full or partial network URL
const netKey = (url, project) => {
  const m = /projects\/([^/]+)\/global\/networks\/([^/]+)/.exec(String(url ?? ""));
  return m ? `projects/${m[1]}/global/networks/${m[2]}` : url ? `projects/${project}/global/networks/${last(url)}` : null;
};

function portRange(p) {
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(p).trim());
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
}

export function normalizeGcp(doc, meta) {
  const file = meta.path || meta.file;
  const out = emptyFragment();
  const src = (path) => ({ file, path });
  const list = (key) => (Array.isArray(doc[key]) ? doc[key] : []);

  const proj = doc.Project || null;
  if (!proj) out.notInExport.push({ file, path: "$.Project", what: "Project section" });
  const projectId = proj?.projectId || `unknown:${file}`;
  const labels = proj?.labels ?? null;
  if (proj && !proj.labels) out.notInExport.push({ file, path: "$.Project.labels", what: "Project labels" });

  const regionSrc = {};
  const seeRegion = (url, path) => { const r = last(url); if (r && !(r in regionSrc)) regionSrc[r] = `${path}.region`; };
  for (const key of ["Subnetworks", "Routers", "ForwardingRules", "BackendServices", "VpnTunnels"]) {
    list(key).forEach((x, i) => x.region && seeRegion(x.region, `$.${key}[${i}]`));
  }
  const regions = Object.keys(regionSrc);
  // Networks are global, so "global" gets the same section map as the regions.
  const { sections, sectionPaths, notInExport } = fileSections(doc, FORMAT, [...regions, "global"], file);
  out.notInExport.push(...notInExport);

  out.accounts.push({
    cloud: "gcp", id: projectId, name: proj?.name || projectId, company: meta.folder || null,
    exportCompany: null, dir: meta.dir ?? null, file, tags: labels, role: getTag(labels, "AccountRole"),
    environment: getTag(labels, "Environment"), regions, sections, sectionPaths,
    tagsPath: "$.Project.labels", regionSrc, src: src("$.Project"),
  });
  const base = (region) => ({ cloud: "gcp", accountId: projectId, region });

  const subnets = list("Subnetworks");
  list("Networks").forEach((n, i) => {
    const id = netKey(n.selfLink, projectId) ?? `projects/${projectId}/global/networks/${n.name}`;
    const mine = subnets.filter((s) => netKey(s.network, projectId) === id);
    out.networks.push({
      ...base("global"), id, name: n.name ?? null, kind: "VPC network", cidrs: mine.map((s) => s.ipCidrRange).filter(Boolean),
      cidrSource: "subnets", isDefault: n.name === "default", autoMode: n.autoCreateSubnetworks === true, state: null,
      tags: null, tagsPath: null, flowLogScope: "subnet", azs: [], src: src(`$.Networks[${i}]`),
    });
    (n.peerings || []).forEach((p, j) => {
      const remote = netKey(p.network, projectId);
      out.peerings.push({
        cloud: "gcp", id: [id, remote].sort().join("|"), status: p.state ?? null, active: p.state === "ACTIVE",
        requester: { accountId: projectId, networkId: id, cidr: null, region: "global" },
        accepter: { accountId: /projects\/([^/]+)/.exec(remote || "")?.[1] ?? null, networkId: remote, cidr: null, region: "global" },
        seenIn: [src(`$.Networks[${i}].peerings[${j}]`)], src: src(`$.Networks[${i}].peerings[${j}]`),
      });
    });
  });

  subnets.forEach((s, i) => {
    const id = s.selfLink ?? `${last(s.region)}/${s.name}`;
    out.subnets.push({
      ...base(last(s.region)), id, networkId: netKey(s.network, projectId), name: s.name ?? null, tier: null,
      cidr: s.ipCidrRange ?? null, az: null, mapPublicIp: false, routeTableId: null, public: null,
      src: src(`$.Subnetworks[${i}]`),
    });
    // Only a logConfig that is present says whether flow logs are on.
    if (s.logConfig && typeof s.logConfig.enable === "boolean") {
      out.flowLogs.push({
        ...base(last(s.region)), id: `${id}#logConfig`, resourceId: id, status: s.logConfig.enable ? "enabled" : "disabled",
        active: s.logConfig.enable, trafficType: null, destination: null, src: src(`$.Subnetworks[${i}].logConfig`),
      });
    }
  });

  list("Firewalls").forEach((f, i) => {
    const networkId = netKey(f.network, projectId);
    out.securityGroups.push({
      ...base("global"), id: f.selfLink ?? f.name, networkId, groupName: f.name, name: f.name, kind: "firewall rule",
      description: null, disabled: f.disabled === true, src: src(`$.Firewalls[${i}]`),
    });
    if (f.disabled === true) return; // a disabled rule opens nothing
    const direction = f.direction === "EGRESS" ? "egress" : "ingress";
    const ranges = direction === "ingress" ? f.sourceRanges || [] : f.destinationRanges || [];
    (f.allowed || []).forEach((a, j) => {
      const proto = String(a.IPProtocol ?? "").toLowerCase();
      const ports = (a.ports || []).map(portRange).filter(Boolean);
      for (const [lo, hi] of ports.length ? ports : [[0, 65535]]) {
        const protocol = proto === "all" ? "all" : proto;
        for (const r of ranges) {
          out.firewallRules.push({
            ...base("global"), groupId: f.selfLink ?? f.name, groupName: f.name, groupKind: "firewall rule", networkId, direction,
            protocol, fromPort: lo, toPort: hi, source: { kind: "cidr", value: r }, fromWorld: WORLD.has(r),
            src: src(`$.Firewalls[${i}].allowed[${j}]`),
          });
        }
      }
    });
  });

  const routers = list("Routers");
  list("RouterNats").forEach((n, i) => {
    const r = routers.find((x) => x.name === n.router);
    out.gateways.push({
      ...base(r ? last(r.region) : null), kind: "nat", id: `${n.router}/${n.name}`, name: n.name ?? null,
      networkIds: r ? [netKey(r.network, projectId)] : [], subnetId: null, az: null, state: null,
      src: src(`$.RouterNats[${i}]`),
    });
  });

  list("SecurityPolicies").forEach((p, i) => {
    out.wafAcls.push({ ...base("global"), id: p.selfLink ?? p.name, name: p.name ?? null, scope: p.type ?? null, src: src(`$.SecurityPolicies[${i}]`) });
  });

  list("BackendServices").forEach((b, i) => {
    out.loadBalancers.push({
      ...base(b.region ? last(b.region) : "global"), id: b.selfLink ?? b.name, name: b.name ?? null, type: "backend service",
      kind: "backend service", scheme: b.loadBalancingScheme ?? null,
      internetFacing: /^EXTERNAL/.test(b.loadBalancingScheme ?? ""), networkId: b.network ? netKey(b.network, projectId) : null,
      azs: [], dnsName: null, wafAclArn: b.securityPolicy || null, src: src(`$.BackendServices[${i}]`),
    });
  });

  return out;
}
