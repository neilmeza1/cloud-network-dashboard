// Count summary over the normalized model: per account and per company.
// A count is null ("not in export") when a section it depends on is missing from the file.

import { GLOBAL_SCOPE } from "./concepts.js";

const regionOf = (a) => a.regions;
const mine = (rows, a) => rows.filter((r) => r.accountId === a.id);
const uniq = (xs) => new Set(xs.filter((x) => x !== null && x !== undefined)).size;

// sections: the concepts a count reads (see concepts.js). "global." prefix means the AWS Global block.
export const COUNTS = [
  { key: "regions", label: "Regions", sections: [],
    definition: "Regions the file has resources in.",
    account: (m, a) => regionOf(a).length,
    company: (m, accts) => uniq(accts.flatMap(regionOf)) },
  { key: "azs", label: "Zones", sections: ["Zones"],
    definition: "Distinct availability zones that have at least one subnet.",
    account: (m, a) => uniq(mine(m.subnets, a).map((s) => s.az)),
    company: (m, accts) => uniq(accts.flatMap((a) => mine(m.subnets, a).map((s) => s.az))) },
  { key: "vpcs", label: "Networks", sections: ["Vpcs"],
    definition: "Private networks: VPCs in AWS, VNets (virtual networks) in Azure, VPC networks in GCP. Includes default networks.",
    account: (m, a) => mine(m.networks, a).length },
  { key: "defaultVpcs", label: "Default networks", sections: ["Vpcs"],
    definition: "Default networks: AWS VPCs with IsDefault: true, and the GCP network named default. Azure has no default network.",
    account: (m, a) => mine(m.networks, a).filter((n) => n.isDefault).length },
  { key: "subnets", label: "Subnets", sections: ["Subnets"],
    definition: "All subnets.",
    account: (m, a) => mine(m.subnets, a).length },
  { key: "publicSubnets", label: "Public subnets", sections: ["Subnets", "RouteTables"],
    definition: "Subnets whose route table sends 0.0.0.0/0 to an internet gateway. Needs route tables, which only the AWS export has.",
    account: (m, a) => mine(m.subnets, a).filter((s) => s.public).length },
  { key: "internetGateways", label: "Internet gateways", sections: ["InternetGateways"],
    definition: "AWS internet gateways (the door between a VPC and the public internet). The Azure and GCP exports have no such resource.",
    account: (m, a) => mine(m.gateways, a).filter((g) => g.kind === "internet").length },
  { key: "natGateways", label: "NAT gateways", sections: ["NatGateways"],
    definition: "Outbound-only internet access for private resources: AWS and Azure NAT gateways, GCP Cloud NAT.",
    account: (m, a) => mine(m.gateways, a).filter((g) => g.kind === "nat").length },
  { key: "transitGateways", label: "Transit gateways", sections: ["TransitGateways"],
    definition: "AWS transit gateways owned by the account (hubs that connect networks and accounts). Not in the Azure or GCP exports.",
    account: (m, a) => mine(m.gateways, a).filter((g) => g.kind === "transit").length },
  { key: "transitAttachments", label: "TGW attachments", sections: ["TransitGatewayAttachments"],
    definition: "Transit gateway attachments of this account's resources. Company total counts each attachment id once.",
    account: (m, a) => m.transitAttachments.filter((t) => t.resourceOwnerId === a.id).length,
    company: (m, accts) => {
      const ids = new Set(accts.map((a) => a.id));
      return m.transitAttachments.filter((t) => ids.has(t.resourceOwnerId) || ids.has(t.transitOwnerId)).length;
    } },
  { key: "peerings", label: "Peerings", sections: ["VpcPeeringConnections"],
    definition: "Active network peerings (AWS VPC peering, Azure VNet peering, GCP network peering) involving the account. Company total counts each peering once.",
    account: (m, a) => m.peerings.filter((p) => p.active && (p.requester.accountId === a.id || p.accepter.accountId === a.id)).length,
    company: (m, accts) => {
      const ids = new Set(accts.map((a) => a.id));
      return m.peerings.filter((p) => p.active && (ids.has(p.requester.accountId) || ids.has(p.accepter.accountId))).length;
    } },
  { key: "endpoints", label: "Private endpoints", sections: ["VpcEndpoints"],
    definition: "Private connections to cloud services: AWS VPC endpoints, Azure private endpoints. Not in the GCP export.",
    account: (m, a) => mine(m.endpoints, a).length },
  { key: "interfaces", label: "Network interfaces", sections: ["NetworkInterfaces"],
    definition: "All network interfaces (AWS ENIs), infrastructure and workload. Not in the Azure or GCP exports.",
    account: (m, a) => mine(m.interfaces, a).length },
  { key: "workloadInterfaces", label: "Workload ENIs", sections: ["NetworkInterfaces"],
    definition: "Interfaces of type 'interface' whose description does not start with 'ELB '. They stand in for workloads.",
    account: (m, a) => mine(m.interfaces, a).filter((i) => i.role === "workload").length },
  { key: "securityGroups", label: "Security groups", sections: ["SecurityGroups"],
    definition: "Virtual firewalls: AWS security groups, Azure network security groups, GCP firewall rules.",
    account: (m, a) => mine(m.securityGroups, a).length },
  { key: "worldIngressRules", label: "World-open inbound rules", sections: ["SecurityGroups"],
    definition: "Inbound allow-rule sources open to anyone (0.0.0.0/0, ::/0, or Azure's * and Internet), any port.",
    account: (m, a) => mine(m.firewallRules, a).filter((r) => r.direction === "ingress" && r.fromWorld).length },
  { key: "loadBalancers", label: "Load balancers", sections: ["LoadBalancers"],
    definition: "Load balancers: AWS load balancers, Azure application gateways, GCP backend services.",
    account: (m, a) => mine(m.loadBalancers, a).length },
  { key: "publicLoadBalancers", label: "Internet-facing LBs", sections: ["LoadBalancers"],
    definition: "Load balancers reachable from the internet: AWS Scheme internet-facing, Azure application gateways with a public frontend IP, GCP EXTERNAL backend services.",
    account: (m, a) => mine(m.loadBalancers, a).filter((l) => l.internetFacing).length },
  { key: "listeners", label: "Listeners", sections: ["Listeners"],
    definition: "Load balancer listeners (port and protocol a load balancer accepts). Only the AWS export has them.",
    account: (m, a) => mine(m.listeners, a).length },
  { key: "cdnDistributions", label: "CloudFront", sections: ["global.CloudFrontDistributions"],
    definition: "AWS CloudFront (CDN) distributions. The Azure and GCP exports have no CDN section.",
    account: (m, a) => mine(m.cdnDistributions, a).length },
  { key: "activeFlowLogs", label: "Active flow logs", sections: ["FlowLogs"],
    definition: "Flow logs that are on: AWS FlowLogStatus ACTIVE, Azure enabled flow logs, GCP subnets with logging enabled.",
    account: (m, a) => mine(m.flowLogs, a).filter((f) => f.active).length },
];

// True when every section the count reads is present in every region of the file.
function hasSections(a, sections) {
  return sections.every((s) => {
    if (s.startsWith("global.")) return a.sections[GLOBAL_SCOPE]?.[s.slice(7)] === true;
    return a.regions.every((r) => a.sections[r]?.[s] === true);
  });
}

// Returns { columns, companies: [{ name, total: {key: n|null}, partial: {key: [files]}, accounts: [...] }] }
export function countSummary(model) {
  const companies = model.companies.map(({ name, accountIds }) => {
    const accts = model.accounts.filter((a) => accountIds.includes(a.id));
    const rows = accts.map((a) => {
      const counts = {};
      for (const c of COUNTS) counts[c.key] = hasSections(a, c.sections) ? c.account(model, a) : null;
      return { id: a.id, name: a.name, file: a.file, role: a.role, regions: a.regions, counts };
    });
    const total = {};
    const partial = {};
    for (const c of COUNTS) {
      const have = accts.filter((a) => hasSections(a, c.sections));
      const missingIn = accts.filter((a) => !hasSections(a, c.sections)).map((a) => a.file);
      if (missingIn.length) partial[c.key] = missingIn;
      total[c.key] = !have.length ? null
        : c.company ? c.company(model, have)
        : have.reduce((n, a) => n + c.account(model, a), 0);
    }
    return { name, total, partial, accounts: rows };
  });
  return { columns: COUNTS.map(({ key, label, definition }) => ({ key, label, definition })), companies };
}

// Plain-text table, used by the dev page and handy for diffing against the generator output.
export function formatSummary(summary) {
  const cols = summary.columns;
  const head = ["account", ...cols.map((c) => c.key)];
  const lines = [];
  const show = (v) => (v === null ? "not in export" : String(v));
  for (const co of summary.companies) {
    lines.push(`== ${co.name} (${co.accounts.length} accounts)`);
    const table = [head, ...co.accounts.map((a) => [a.name || a.id, ...cols.map((c) => show(a.counts[c.key]))]),
      ["TOTAL", ...cols.map((c) => show(co.total[c.key]) + (co.partial[c.key] ? "*" : ""))]];
    const widths = head.map((_, i) => Math.max(...table.map((r) => r[i].length)));
    for (const r of table) lines.push(r.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd());
    for (const [k, files] of Object.entries(co.partial)) lines.push(`  * ${k}: section missing in ${files.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}
