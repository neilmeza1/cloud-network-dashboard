// Shared vocabulary for the normalized model.
//
// Section keys are the concepts the checks, counts and map read. AWS names them after its
// own sections; Azure and GCP normalizers map their sections onto the same keys. A concept
// a format does not have is recorded as not in export, so nothing is inferred from silence.

export const CLOUD_NAME = { aws: "AWS", azure: "Azure", gcp: "GCP" };

export const CONCEPT_LABEL = {
  Vpcs: "networks", Subnets: "subnets", RouteTables: "route tables", InternetGateways: "internet gateways",
  NatGateways: "NAT gateways", TransitGateways: "transit gateways", TransitGatewayAttachments: "transit gateway attachments",
  VpcEndpoints: "private endpoints", NetworkInterfaces: "network interfaces", SecurityGroups: "firewall rules",
  VpcPeeringConnections: "peerings", FlowLogs: "flow logs", LoadBalancers: "load balancers", Listeners: "load balancer listeners",
  WebAcls: "WAF rule sets", WebAclResources: "WAF associations", Zones: "availability zones", NetworkTags: "network tags",
  CloudFrontDistributions: "CDN distributions", WebAclsGlobal: "global WAF rule sets",
};

export const REGION_CONCEPTS = [
  "Vpcs", "Subnets", "RouteTables", "InternetGateways", "NatGateways", "TransitGateways", "TransitGatewayAttachments",
  "VpcEndpoints", "NetworkInterfaces", "SecurityGroups", "VpcPeeringConnections", "FlowLogs", "LoadBalancers",
  "Listeners", "WebAcls", "WebAclResources", "Zones", "NetworkTags",
];
export const GLOBAL_CONCEPTS = ["CloudFrontDistributions", "WebAclsGlobal"];

// Scope key for the AWS Global block (CloudFront and its WAF). Kept apart from region
// names because GCP networks and backend services are themselves "global".
export const GLOBAL_SCOPE = "$global";

// Tag lookup that ignores case: GCP labels are lowercase (accountrole, environment).
export function getTag(tags, name) {
  if (!tags) return null;
  if (name in tags) return tags[name];
  const k = Object.keys(tags).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? null : tags[k];
}

// Section presence for formats whose sections are file-wide lists (Azure, GCP).
// format: { concept: "$.SectionName" | null }  (null: the format has no such section)
// Returns sections per region (the same map for every region), the path of each concept,
// and the not-in-export entries for sections the format has but this file lacks.
export function fileSections(doc, format, regions, file) {
  const present = {};
  const sectionPaths = {};
  const notInExport = [];
  for (const key of [...REGION_CONCEPTS, ...GLOBAL_CONCEPTS]) {
    const path = format[key] ?? null;
    sectionPaths[key] = path;
    const name = path && path.slice(2);
    present[key] = !!path && Array.isArray(doc[name]);
    if (path && !present[key] && !notInExport.some((x) => x.path === path)) {
      notInExport.push({ file, path, what: name });
    }
  }
  const sections = {};
  for (const r of regions) sections[r] = Object.fromEntries(REGION_CONCEPTS.map((k) => [k, present[k]]));
  sections[GLOBAL_SCOPE] = Object.fromEntries(GLOBAL_CONCEPTS.map((k) => [k, present[k]]));
  return { sections, sectionPaths, notInExport };
}
