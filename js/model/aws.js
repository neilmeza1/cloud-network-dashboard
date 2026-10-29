// AWS normalizer: one `aws-account-inventory/1.0` file -> one model fragment.
// The fragment has the same collections as the merged model (see model.js).
// Every record carries `src: { file, path }` so a finding can cite its evidence.
// A section missing from the file is recorded in `notInExport`, never treated as empty.

export const AWS_REGION_SECTIONS = [
  "Vpcs", "Subnets", "RouteTables", "InternetGateways", "NatGateways",
  "TransitGateways", "TransitGatewayAttachments", "VpcEndpoints",
  "NetworkInterfaces", "SecurityGroups", "VpcPeeringConnections", "FlowLogs",
  "LoadBalancers", "Listeners", "WebAcls", "WebAclResources",
];
export const AWS_GLOBAL_SECTIONS = ["CloudFrontDistributions", "WebAclsGlobal"];

const WORLD = new Set(["0.0.0.0/0", "::/0"]);

function tagMap(tags) {
  if (Array.isArray(tags)) return Object.fromEntries(tags.map((t) => [t.Key, t.Value]));
  return tags && typeof tags === "object" ? { ...tags } : {};
}

// JSON path in the form $.Regions["us-east-1"].Vpcs[0]
function jp(...parts) {
  return "$" + parts.map((p) => (typeof p === "number" ? `[${p}]` : /^[A-Za-z_]\w*$/.test(p) ? `.${p}` : `["${p}"]`)).join("");
}

export function emptyFragment() {
  return {
    accounts: [], networks: [], subnets: [], routeTables: [], gateways: [],
    transitAttachments: [], endpoints: [], interfaces: [], securityGroups: [],
    firewallRules: [], loadBalancers: [], listeners: [], cdnDistributions: [],
    wafAcls: [], peerings: [], flowLogs: [], notInExport: [],
  };
}

function interfaceRole(eni) {
  if (eni.InterfaceType === "nat_gateway") return "nat_gateway";
  if (eni.InterfaceType === "vpc_endpoint") return "vpc_endpoint";
  if ((eni.Description || "").startsWith("ELB ")) return "load_balancer";
  if (eni.InterfaceType === "interface") return "workload";
  return "other";
}

function routeTarget(r) {
  for (const [field, type] of [
    ["GatewayId", null], ["NatGatewayId", "nat"], ["TransitGatewayId", "transit"],
    ["VpcPeeringConnectionId", "peering"], ["NetworkInterfaceId", "interface"],
    ["VpcEndpointId", "endpoint"],
  ]) {
    const v = r[field];
    if (!v) continue;
    let t = type;
    if (!t) t = v === "local" ? "local" : v.startsWith("igw-") ? "internet" : v.startsWith("vpce-") ? "endpoint" : "gateway";
    return { target: v, targetType: t };
  }
  return { target: null, targetType: "unknown" };
}

// meta: { file, path, folder }  (path is the relative path shown as evidence)
export function normalizeAws(doc, meta) {
  const file = meta.path || meta.file;
  const out = emptyFragment();
  const missing = (path, what) => out.notInExport.push({ file, path, what });
  const src = (...parts) => ({ file, path: jp(...parts) });

  // Account
  const acct = doc.Account || null;
  if (!acct) missing("$.Account", "Account section");
  const accountId = (acct && acct.AccountId) || `unknown:${file}`;
  if (acct && !acct.AccountId) missing("$.Account.AccountId", "Account ID");
  const accountTags = acct && acct.Tags ? tagMap(acct.Tags) : null; // null: not in export
  const company = (acct && acct.Company) || meta.folder || null;
  if (acct && !acct.Company) missing("$.Account.Company", "Company name");
  if (acct && !acct.Tags) missing("$.Account.Tags", "Account tags");

  const regionsObj = doc.Regions && typeof doc.Regions === "object" ? doc.Regions : null;
  if (!regionsObj) missing("$.Regions", "Regions section");
  const regionNames = regionsObj ? Object.keys(regionsObj) : [];

  const sections = {}; // region -> { section: true|false }
  out.accounts.push({
    cloud: "aws", id: accountId, name: (acct && acct.AccountName) || null, company,
    exportCompany: (acct && acct.Company) || null, dir: meta.dir ?? null, file, tags: accountTags, role: accountTags?.AccountRole ?? null,
    environment: accountTags?.Environment ?? null, regions: regionNames, sections,
    src: src("Account"),
  });

  for (const region of regionNames) {
    const R = regionsObj[region] || {};
    sections[region] = {};
    const list = (key) => {
      const ok = Array.isArray(R[key]);
      sections[region][key] = ok;
      if (!ok) missing(jp("Regions", region, key), `${key} in ${region}`);
      return ok ? R[key] : [];
    };
    const base = { cloud: "aws", accountId, region };

    for (const [i, v] of list("Vpcs").entries()) {
      const tags = tagMap(v.Tags);
      const cidrs = (v.CidrBlockAssociationSet || []).map((a) => a.CidrBlock).filter(Boolean);
      if (v.CidrBlock && !cidrs.includes(v.CidrBlock)) cidrs.unshift(v.CidrBlock);
      out.networks.push({
        ...base, id: v.VpcId, name: tags.Name ?? null, cidrs, isDefault: v.IsDefault === true,
        state: v.State ?? null, tags, azs: [], src: src("Regions", region, "Vpcs", i),
      });
    }

    for (const [i, s] of list("Subnets").entries()) {
      const tags = tagMap(s.Tags);
      out.subnets.push({
        ...base, id: s.SubnetId, networkId: s.VpcId, name: tags.Name ?? null,
        tier: tags.Tier ?? null, cidr: s.CidrBlock ?? null, az: s.AvailabilityZone ?? null,
        mapPublicIp: s.MapPublicIpOnLaunch === true, routeTableId: null, public: null,
        src: src("Regions", region, "Subnets", i),
      });
    }

    for (const [i, rt] of list("RouteTables").entries()) {
      const assoc = rt.Associations || [];
      out.routeTables.push({
        ...base, id: rt.RouteTableId, networkId: rt.VpcId, name: tagMap(rt.Tags).Name ?? null,
        isMain: assoc.some((a) => a.Main === true),
        subnetIds: assoc.map((a) => a.SubnetId).filter(Boolean),
        routes: (rt.Routes || []).map((r) => ({
          destination: r.DestinationCidrBlock || r.DestinationIpv6CidrBlock || r.DestinationPrefixListId || null,
          state: r.State ?? null, ...routeTarget(r),
        })),
        src: src("Regions", region, "RouteTables", i),
      });
    }

    for (const [i, g] of list("InternetGateways").entries()) {
      out.gateways.push({
        ...base, kind: "internet", id: g.InternetGatewayId, name: tagMap(g.Tags).Name ?? null,
        networkIds: (g.Attachments || []).map((a) => a.VpcId), subnetId: null, az: null,
        state: (g.Attachments || [])[0]?.State ?? null, src: src("Regions", region, "InternetGateways", i),
      });
    }
    for (const [i, g] of list("NatGateways").entries()) {
      out.gateways.push({
        ...base, kind: "nat", id: g.NatGatewayId, name: tagMap(g.Tags).Name ?? null,
        networkIds: [g.VpcId], subnetId: g.SubnetId ?? null, az: null, state: g.State ?? null,
        connectivity: g.ConnectivityType ?? null, src: src("Regions", region, "NatGateways", i),
      });
    }
    for (const [i, g] of list("TransitGateways").entries()) {
      out.gateways.push({
        ...base, kind: "transit", id: g.TransitGatewayId, name: tagMap(g.Tags).Name ?? null,
        ownerId: g.OwnerId ?? accountId, networkIds: [], subnetId: null, az: null,
        state: g.State ?? null, src: src("Regions", region, "TransitGateways", i),
      });
    }

    for (const [i, a] of list("TransitGatewayAttachments").entries()) {
      out.transitAttachments.push({
        cloud: "aws", region, id: a.TransitGatewayAttachmentId, transitGatewayId: a.TransitGatewayId,
        transitOwnerId: a.TransitGatewayOwnerId ?? null, resourceOwnerId: a.ResourceOwnerId ?? null,
        resourceType: a.ResourceType ?? null, networkId: a.ResourceType === "vpc" ? a.ResourceId : null,
        state: a.State ?? null, seenIn: [src("Regions", region, "TransitGatewayAttachments", i)],
        src: src("Regions", region, "TransitGatewayAttachments", i),
      });
    }

    for (const [i, e] of list("VpcEndpoints").entries()) {
      const service = e.ServiceName ?? null;
      const prefix = `com.amazonaws.${region}.`;
      out.endpoints.push({
        ...base, id: e.VpcEndpointId, networkId: e.VpcId, service,
        serviceShort: service && service.startsWith(prefix) ? service.slice(prefix.length) : service,
        type: (e.VpcEndpointType || "").toLowerCase() || null, state: e.State ?? null,
        src: src("Regions", region, "VpcEndpoints", i),
      });
    }

    for (const [i, n] of list("NetworkInterfaces").entries()) {
      out.interfaces.push({
        ...base, id: n.NetworkInterfaceId, networkId: n.VpcId, subnetId: n.SubnetId ?? null,
        az: n.AvailabilityZone ?? null, type: n.InterfaceType ?? null, role: interfaceRole(n),
        description: n.Description ?? "", privateIp: n.PrivateIpAddress ?? null,
        publicIp: n.Association?.PublicIp ?? null, groupIds: (n.Groups || []).map((g) => g.GroupId),
        src: src("Regions", region, "NetworkInterfaces", i),
      });
    }

    for (const [i, g] of list("SecurityGroups").entries()) {
      const name = tagMap(g.Tags).Name ?? g.GroupName ?? g.GroupId;
      out.securityGroups.push({
        ...base, id: g.GroupId, networkId: g.VpcId ?? null, groupName: g.GroupName ?? null, name,
        description: g.Description ?? null, src: src("Regions", region, "SecurityGroups", i),
      });
      for (const [direction, key] of [["ingress", "IpPermissions"], ["egress", "IpPermissionsEgress"]]) {
        for (const [j, p] of (g[key] || []).entries()) {
          const rule = {
            ...base, groupId: g.GroupId, groupName: name, networkId: g.VpcId ?? null, direction,
            protocol: p.IpProtocol === "-1" ? "all" : String(p.IpProtocol),
            fromPort: p.FromPort ?? null, toPort: p.ToPort ?? null,
            src: src("Regions", region, "SecurityGroups", i, key, j),
          };
          const sources = [
            ...(p.IpRanges || []).map((r) => ({ kind: "cidr", value: r.CidrIp })),
            ...(p.Ipv6Ranges || []).map((r) => ({ kind: "cidr", value: r.CidrIpv6 })),
            ...(p.PrefixListIds || []).map((r) => ({ kind: "prefix-list", value: r.PrefixListId })),
            ...(p.UserIdGroupPairs || []).map((r) => ({ kind: "group", value: r.GroupId })),
          ];
          for (const s of sources) {
            out.firewallRules.push({ ...rule, source: s, fromWorld: s.kind === "cidr" && WORLD.has(s.value) });
          }
        }
      }
    }

    // WAF links live in WebAclResources, not on the load balancer.
    const wafByResource = new Map();
    for (const w of list("WebAclResources")) {
      for (const arn of w.ResourceArns || []) wafByResource.set(arn, w.WebAclArn);
    }
    for (const [i, w] of list("WebAcls").entries()) {
      out.wafAcls.push({ ...base, id: w.ARN, name: w.Name ?? null, scope: w.Scope ?? null, src: src("Regions", region, "WebAcls", i) });
    }
    const wafKnown = sections[region].WebAclResources;

    for (const [i, lb] of list("LoadBalancers").entries()) {
      out.loadBalancers.push({
        ...base, id: lb.LoadBalancerArn, name: lb.LoadBalancerName ?? null, type: lb.Type ?? null,
        scheme: lb.Scheme ?? null, internetFacing: lb.Scheme === "internet-facing",
        networkId: lb.VpcId ?? null, azs: (lb.AvailabilityZones || []).map((z) => z.ZoneName),
        dnsName: lb.DNSName ?? null,
        wafAclArn: wafKnown ? wafByResource.get(lb.LoadBalancerArn) ?? null : undefined,
        src: src("Regions", region, "LoadBalancers", i),
      });
    }
    for (const [i, l] of list("Listeners").entries()) {
      const actions = l.DefaultActions || [];
      out.listeners.push({
        ...base, id: l.ListenerArn, loadBalancerId: l.LoadBalancerArn, port: l.Port ?? null,
        protocol: l.Protocol ?? null, defaultActions: actions.map((a) => a.Type),
        redirectsToHttps: actions.some((a) => a.Type === "redirect" && a.RedirectConfig?.Protocol === "HTTPS"),
        src: src("Regions", region, "Listeners", i),
      });
    }

    for (const [i, p] of list("VpcPeeringConnections").entries()) {
      const side = (v) => ({ accountId: v?.OwnerId ?? null, networkId: v?.VpcId ?? null, cidr: v?.CidrBlock ?? null, region: v?.Region ?? null });
      out.peerings.push({
        cloud: "aws", id: p.VpcPeeringConnectionId, status: p.Status?.Code ?? null,
        active: p.Status?.Code === "active", requester: side(p.RequesterVpcInfo),
        accepter: side(p.AccepterVpcInfo), seenIn: [src("Regions", region, "VpcPeeringConnections", i)],
        src: src("Regions", region, "VpcPeeringConnections", i),
      });
    }

    for (const [i, f] of list("FlowLogs").entries()) {
      out.flowLogs.push({
        ...base, id: f.FlowLogId, resourceId: f.ResourceId, status: f.FlowLogStatus ?? null,
        active: f.FlowLogStatus === "ACTIVE", trafficType: f.TrafficType ?? null,
        destination: f.LogDestination ?? null, src: src("Regions", region, "FlowLogs", i),
      });
    }
  }

  // Global (CloudFront and its WAF)
  const G = doc.Global && typeof doc.Global === "object" ? doc.Global : null;
  if (!G) missing("$.Global", "Global section (CloudFront)");
  const globalSections = {};
  for (const key of AWS_GLOBAL_SECTIONS) {
    globalSections[key] = !!G && Array.isArray(G[key]);
    if (G && !globalSections[key]) missing(jp("Global", key), key);
  }
  sections.global = globalSections;
  if (globalSections.WebAclsGlobal) {
    for (const [i, w] of G.WebAclsGlobal.entries()) {
      out.wafAcls.push({ cloud: "aws", accountId, region: "global", id: w.ARN, name: w.Name ?? null, scope: w.Scope ?? null, src: src("Global", "WebAclsGlobal", i) });
    }
  }
  if (globalSections.CloudFrontDistributions) {
    for (const [i, d] of G.CloudFrontDistributions.entries()) {
      out.cdnDistributions.push({
        cloud: "aws", accountId, region: "global", id: d.Id, aliases: d.Aliases?.Items || [],
        domainName: d.DomainName ?? null, enabled: d.Enabled !== false,
        // "" means no WAF; a missing field means the export cannot say
        wafAclArn: d.WebACLId === undefined ? undefined : d.WebACLId || null,
        src: src("Global", "CloudFrontDistributions", i),
      });
    }
  }

  deriveAws(out);
  return out;
}

// Facts that need several sections joined: subnet route table, public subnets,
// NAT zone, VPC zones.
function deriveAws(out) {
  const subnetById = new Map(out.subnets.map((s) => [s.id, s]));
  const explicit = new Map();
  const mainByVpc = new Map();
  for (const rt of out.routeTables) {
    for (const sid of rt.subnetIds) explicit.set(sid, rt);
    if (rt.isMain) mainByVpc.set(rt.networkId, rt);
  }
  const routeKnown = (s) => out.accounts[0].sections[s.region]?.RouteTables;
  for (const s of out.subnets) {
    if (!routeKnown(s)) continue; // stays null: not in export
    const rt = explicit.get(s.id) || mainByVpc.get(s.networkId) || null;
    s.routeTableId = rt ? rt.id : null;
    s.public = !!rt && rt.routes.some((r) => r.targetType === "internet" && WORLD.has(r.destination));
  }
  for (const g of out.gateways) {
    if (g.kind === "nat" && g.subnetId) g.az = subnetById.get(g.subnetId)?.az ?? null;
  }
  for (const n of out.networks) {
    n.azs = [...new Set(out.subnets.filter((s) => s.networkId === n.id && s.az).map((s) => s.az))].sort();
  }
}
