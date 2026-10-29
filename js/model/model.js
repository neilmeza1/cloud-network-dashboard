// Builds the single normalized model from uploaded files. Checks and rendering read only this.
//
// model = {
//   files:       [{ file, format, company, accountId }]
//   errors:      [{ file, message }]
//   notInExport: [{ file, path, what }]       sections the file does not contain
//   companies:   [{ name, accountIds }]
//   accounts, networks, subnets, routeTables, gateways (kind: internet | nat | transit),
//   transitAttachments, endpoints, interfaces (role: workload | nat_gateway | vpc_endpoint |
//   load_balancer | other), securityGroups, firewallRules (one row per rule source),
//   loadBalancers, listeners, cdnDistributions, wafAcls, peerings, flowLogs
// }
// Records shared between files (peerings, transit gateway attachments) are kept once,
// with `seenIn` listing every file that reported them.

import { detectFormat } from "./detect.js";
import { normalizeAws, emptyFragment } from "./aws.js";

const NORMALIZERS = { aws: normalizeAws };
const SHARED = ["peerings", "transitAttachments"];

// inputs: [{ path, text }]  path is the relative path (webkitRelativePath or sample path)
export function buildModel(inputs) {
  const model = { files: [], errors: [], companies: [], ...emptyFragment() };

  for (const { path, text } of inputs) {
    const parts = path.split("/");
    const file = parts[parts.length - 1];
    const folder = parts.length > 1 ? parts[parts.length - 2] : null;
    let doc, format;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      model.errors.push({ file: path, message: `${path}: not valid JSON (${e.message}).` });
      continue;
    }
    try {
      format = detectFormat(doc, path);
      const normalize = NORMALIZERS[format];
      if (!normalize) throw new Error(`${path}: ${format} files are detected but not parsed yet.`);
      const frag = normalize(doc, { file, path, folder });
      merge(model, frag);
      const acct = frag.accounts[0];
      model.files.push({ file: path, format, company: acct.company, accountId: acct.id });
    } catch (e) {
      model.errors.push({ file: path, message: e.message });
    }
  }

  const byCompany = new Map();
  for (const a of model.accounts) {
    const name = a.company || "Unnamed company";
    if (!byCompany.has(name)) byCompany.set(name, []);
    byCompany.get(name).push(a.id);
  }
  model.companies = [...byCompany].map(([name, accountIds]) => ({ name, accountIds }));
  return model;
}

function merge(model, frag) {
  for (const [key, rows] of Object.entries(frag)) {
    if (!SHARED.includes(key)) {
      model[key].push(...rows);
      continue;
    }
    for (const row of rows) {
      const existing = model[key].find((r) => r.id === row.id);
      if (existing) existing.seenIn.push(...row.seenIn);
      else model[key].push(row);
    }
  }
}
