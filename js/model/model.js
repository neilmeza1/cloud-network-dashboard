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
// with `seenIn` listing every { file, path } that reported them.

import { detectFormat } from "./detect.js";
import { normalizeAws, emptyFragment } from "./aws.js";
import { normalizeAzure } from "./azure.js";
import { normalizeGcp } from "./gcp.js";

const NORMALIZERS = { aws: normalizeAws, azure: normalizeAzure, gcp: normalizeGcp };
const SHARED = ["peerings", "transitAttachments"];

// inputs: [{ path, text }]  path is the relative path (webkitRelativePath or sample path)
export function buildModel(inputs) {
  const model = { files: [], errors: [], companies: [], ...emptyFragment() };

  for (const { path, text } of inputs) {
    const parts = path.split("/");
    const file = parts[parts.length - 1];
    const folder = parts.length > 1 ? parts[parts.length - 2] : null;
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
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
      const frag = normalize(doc, { file, path, folder, dir });
      const dupe = model.accounts.find((a) => a.id === frag.accounts[0].id);
      if (dupe) throw new Error(`${path}: same account (${dupe.id}) as ${dupe.file}; skipped so nothing is counted twice.`);
      merge(model, frag);
      const acct = frag.accounts[0];
      model.files.push({ file: path, format, company: null, accountId: acct.id });
    } catch (e) {
      model.errors.push({ file: path, message: e.message });
    }
  }

  groupCompanies(model);
  return model;
}

// A company is a folder of files. Files picked without a folder group by the company
// name inside the export. The display name is the export's company name when every file
// in the group agrees on one, otherwise the folder name.
function groupCompanies(model) {
  const groups = new Map();
  for (const a of model.accounts) {
    const key = a.dir !== null ? `dir:${a.dir}` : a.exportCompany ? `company:${a.exportCompany}` : "unnamed";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const used = new Set();
  model.companies = [...groups.values()].map((accts) => {
    const names = new Set(accts.map((a) => a.exportCompany));
    const folder = accts[0].dir ? accts[0].dir.split("/").pop() : null;
    let name = names.size === 1 && accts[0].exportCompany ? accts[0].exportCompany : folder || "Unnamed company";
    for (let n = 2; used.has(name); n++) name = `${name.replace(/ \(\d+\)$/, "")} (${n})`;
    used.add(name);
    for (const a of accts) a.company = name;
    return { name, folder, accountIds: accts.map((a) => a.id) };
  });
  for (const f of model.files) f.company = model.accounts.find((a) => a.id === f.accountId)?.company ?? null;
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
