// Checks engine. Runs every detectable mandate in Cloud_Standards.yaml against the model.
//
// result = {
//   findings:   [{ id, standardId, standardName, severity, check, cloud, company, accountIds,
//                  accountNames, networkIds, region, resource: { kind, id, name }, what, action,
//                  evidence: [{ file, path }], files }]   sorted by severity, then standard
//   notChecked: [{ standardId, check, file, accountId, region, path, what }]
//               a check could not run here because a section is not in the export
//   errors:     [{ check, message }]   e.g. a check named in the YAML but not implemented
// }

import { CHECKS } from "./checks.js";

const sectionPath = (scope, region, key) =>
  scope === "account" ? `$.Account.${key}` : scope === "global" ? `$.Global.${key}` : `$.Regions["${region}"].${key}`;

function sectionKnown(a, scope, region, key) {
  if (scope === "account") return key === "Tags" ? a.tags !== null : a[key] != null;
  if (scope === "global") return a.sections.global?.[key] === true;
  return a.sections[region]?.[key] === true;
}

export function runChecks(model, standards) {
  const findings = [], notChecked = [], errors = [];
  const accountsById = new Map(model.accounts.map((a) => [a.id, a]));
  const networksById = new Map(model.networks.map((n) => [n.id, n]));

  for (const [checkId, mandate] of standards.byCheck) {
    const check = CHECKS[checkId];
    if (!check) {
      errors.push({ check: checkId, message: `${mandate.id}: check "${checkId}" is in Cloud_Standards.yaml but not implemented.` });
      continue;
    }
    const needs = check.needs || {};
    const blocked = new Set(); // "accountId|region", "accountId|global", "accountId|*"
    const skip = (a, scope, region, key, block) => {
      blocked.add(`${a.id}|${block}`);
      notChecked.push({
        standardId: mandate.id, check: checkId, file: a.file, accountId: a.id,
        region: scope === "region" ? region : null, path: sectionPath(scope, region, key),
        what: `${key}${scope === "region" ? ` in ${region}` : ""}`,
      });
    };
    for (const a of model.accounts) {
      for (const key of needs.account || []) if (!sectionKnown(a, "account", null, key)) skip(a, "account", null, key, "*");
      for (const r of a.regions) {
        for (const key of needs.region || []) if (!sectionKnown(a, "region", r, key)) skip(a, "region", r, key, r);
      }
      for (const key of needs.global || []) if (!sectionKnown(a, "global", null, key)) skip(a, "global", null, key, "global");
    }

    const ctx = {
      config: standards.config,
      account: (rec) => accountsById.get(rec.accountId),
      // false when the record sits in a scope whose sections are not in the export
      can(rec) {
        const isAccount = accountsById.get(rec.id) === rec;
        const accountId = isAccount ? rec.id : rec.accountId;
        if (!accountId) return true; // shared records (peerings) are checked wherever they were seen
        if (blocked.has(`${accountId}|*`)) return false;
        return isAccount || !blocked.has(`${accountId}|${rec.region}`);
      },
      unknown(rec, where, what) {
        const a = accountsById.get(rec.accountId);
        notChecked.push({ standardId: mandate.id, check: checkId, file: where.file, accountId: a?.id ?? null, region: rec.region ?? null, path: where.path, what });
      },
      report({ record, accountIds, networkIds, region, resource, what, evidence }) {
        const ids = accountIds || [record.accountId];
        const accts = ids.map((id) => accountsById.get(id)).filter(Boolean);
        // VPCs the finding is about; empty for account- or region-level findings
        const nets = networkIds || (networksById.has(record.id) ? [record.id] : record.networkId ? [record.networkId] : []);
        findings.push({
          id: `${mandate.id}:${resource.id}`, standardId: mandate.id, standardName: mandate.name,
          severity: mandate.severity, check: checkId, cloud: record.cloud || accts[0]?.cloud || null,
          company: accts[0]?.company ?? null, accountIds: ids, accountNames: accts.map((a) => a.name || a.id),
          networkIds: nets.filter((id) => networksById.has(id)),
          region: region ?? (record.region || null), resource, what, action: check.action,
          evidence, files: [...new Set(evidence.map((e) => e.file))],
        });
      },
    };
    check.run(model, ctx);
  }

  const rank = (s) => { const i = standards.severityOrder.indexOf(s); return i < 0 ? 99 : i; };
  findings.sort((a, b) => rank(a.severity) - rank(b.severity) || a.standardId.localeCompare(b.standardId) || a.what.localeCompare(b.what));
  return { findings, notChecked, errors };
}
