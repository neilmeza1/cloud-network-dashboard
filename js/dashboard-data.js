// Builds dashboard-data.json for one company (see ai-skills/AI_SKILLS_README.md, analyze-cloud-export).
// The page renders only from this object. Parts, in order:
//   overview, findings, network_map, accounts, standards_gaps
// plus `meta` (sources) and `standards` (mandate text copied from Cloud_Standards.yaml).
//
// Every statement carries `statement`: "Observed" | "Finding" | "Not in export".
// A count is null when a section it needs is not in the export (rendered "Not in export").

import { countSummary, COUNTS } from "./model/counts.js";
import { resolvePath, snippet } from "./model/jsonpath.js";
import { STANDARDS_PATH } from "./standards.js";
import { buildAccounts } from "./accounts-data.js";
import { buildNetworkMap } from "./map-data.js";
import { buildGaps } from "./gaps-data.js";

export const DASHBOARD_SCHEMA = "kestrel-dashboard-data/0.6";
const COUNT = Object.fromEntries(COUNTS.map((c) => [c.key, c]));

// docs: Map(path -> parsed JSON), used to attach the raw snippet behind each piece of evidence.
export function buildDashboardData({ model, checks, standards, docs, company, generated = new Date().toISOString() }) {
  const co = model.companies.find((c) => c.name === company) || model.companies[0];
  if (!co) return null;
  const ids = new Set(co.accountIds);
  const accts = model.accounts.filter((a) => ids.has(a.id));
  const files = new Set(accts.map((a) => a.file));
  const summary = countSummary(model).companies.find((c) => c.name === co.name);

  const count = (key, label) => {
    const value = summary.total[key];
    const notInExportIn = summary.partial[key] || [];
    return {
      key, label: label || COUNT[key].label, definition: COUNT[key].definition, value,
      statement: value === null ? "Not in export" : "Observed", notInExportIn,
    };
  };
  const roles = [...new Set(accts.map((a) => a.role).filter(Boolean))];

  const overview = {
    scope: {
      statement: "Observed",
      company: co.name,
      regions: [...new Set(accts.flatMap((a) => a.regions))].sort(),
      availabilityZones: count("azs", "availability zones"),
      exportsGenerated: [...new Set(accts.map((a) => docs.get(a.file)?._export?.generated).filter(Boolean))].sort(),
    },
    tiles: [
      { key: "accounts", label: "Accounts", layout: "primary",
        definition: "Inventory files analyzed. Each AWS file is one account.",
        items: [{ key: "accounts", label: "accounts", value: accts.length, statement: "Observed",
          definition: "Inventory files analyzed.", notInExportIn: [] }],
        note: roles.length ? `Roles: ${roles.join(", ")}` : null },
      { key: "vpcs", label: "VPCs", layout: "primary",
        definition: "VPCs (virtual private clouds): isolated private networks inside an account. Includes default VPCs.",
        items: [count("vpcs", "VPCs"), count("defaultVpcs", "default")] },
      { key: "subnets", label: "Subnets", layout: "primary",
        definition: "Subnets: slices of a VPC in one availability zone. Public means its route table sends 0.0.0.0/0 to an internet gateway.",
        items: [count("subnets", "subnets"), count("publicSubnets", "public")] },
      { key: "internet", label: "Internet-facing", layout: "list",
        definition: "Entry points from the public internet: internet gateways, internet-facing load balancers and CloudFront (CDN) distributions.",
        items: [count("internetGateways", "internet gateways"), count("publicLoadBalancers", "internet-facing load balancers"),
          count("cdnDistributions", "CloudFront distributions")] },
      { key: "connectivity", label: "Transit and peering", layout: "list",
        definition: "How networks connect: transit gateways (hubs), their attachments (each id counted once), and active VPC peerings (each id counted once).",
        items: [count("transitGateways", "transit gateways"), count("transitAttachments", "transit gateway attachments"),
          count("peerings", "active VPC peerings")] },
    ],
    findingsBySeverity: null, // filled below
  };

  const findings = checks.findings
    .filter((f) => f.accountIds.some((id) => ids.has(id)))
    .map((f) => ({
      statement: "Finding",
      id: f.id, severity: f.severity, standardId: f.standardId, standardName: f.standardName, check: f.check,
      what: f.what, action: f.action, region: f.region, resource: f.resource,
      accountIds: f.accountIds, accountNames: f.accountNames, networkIds: f.networkIds,
      evidence: f.evidence.map((e) => {
        const value = resolvePath(docs.get(e.file), e.path);
        const s = value === undefined ? { text: "(path not found in file)", truncated: false } : snippet(value);
        return { file: e.file, path: e.path, snippet: s.text, snippetShortened: s.truncated };
      }),
    }));

  overview.findingsBySeverity = {
    statement: "Finding",
    definition: "Failed checks against Cloud_Standards.yaml, by the severity the standard assigns.",
    counts: standards.severityOrder.map((sev) => ({
      severity: sev, meaning: standards.config.severity_scale[sev],
      count: findings.filter((f) => f.severity === sev).length,
    })),
  };

  const mandateFields = (m) => ({
    id: m.id, name: m.name, pillar: m.pillar, pillarName: m.pillarName, severity: m.severity,
    check: m.check, statement: (m.statement || "").trim(), why: (m.why || "").trim(),
  });

  return {
    meta: {
      schema: DASHBOARD_SCHEMA, generated, company: co.name,
      files: accts.map((a) => ({
        file: a.file, cloud: a.cloud, accountId: a.id, accountName: a.name, role: a.role,
        exportGenerated: docs.get(a.file)?._export?.generated ?? null,
      })),
      errors: model.errors,
      standards: { path: STANDARDS_PATH, version: standards.meta.version ?? null },
    },
    overview,
    findings,
    network_map: buildNetworkMap({ model, accts, findings, severityOrder: standards.severityOrder }),
    accounts: buildAccounts({ model, accts, summary, findings, severityOrder: standards.severityOrder }),
    standards_gaps: buildGaps({
      standards,
      notChecked: checks.notChecked.filter((n) => files.has(n.file)),
      notInExport: model.notInExport.filter((n) => files.has(n.file)),
    }),
    standards: Object.fromEntries(standards.mandates.map((m) => [m.id, mandateFields(m)])),
  };
}
