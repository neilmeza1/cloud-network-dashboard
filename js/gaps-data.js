// The `standards_gaps` part of dashboard-data: what these files cannot tell us.
//   manual:  every mandate with `check: manual` in Cloud_Standards.yaml, grouped by pillar and
//            sorted by severity. Evidence needed is the YAML's own `enforcement` and `kpi` text.
//   byFile:  checks that could not run, by file and by the missing section that stopped them.
// Everything here is "Not in export"; none of it is repeated in Findings.

export function buildGaps({ standards, notChecked, notInExport }) {
  const rank = (s) => { const i = standards.severityOrder.indexOf(s); return i < 0 ? 99 : i; };
  const pillars = [];
  for (const m of standards.manual) {
    let p = pillars.find((x) => x.id === m.pillar);
    if (!p) pillars.push((p = { id: m.pillar, name: m.pillarName, mandates: [] }));
    p.mandates.push({
      statement: "Not in export",
      id: m.id, name: m.name, severity: m.severity,
      text: (m.statement || "").trim(), why: (m.why || "").trim(),
      evidence: { enforcement: (m.enforcement || "").trim() || null, kpi: (m.kpi || "").trim() || null },
    });
  }
  for (const p of pillars) p.mandates.sort((a, b) => rank(a.severity) - rank(b.severity) || a.id.localeCompare(b.id));

  const byFile = [];
  for (const n of notChecked) {
    let f = byFile.find((x) => x.file === n.file);
    if (!f) byFile.push((f = { file: n.file, sections: [] }));
    let s = f.sections.find((x) => x.path === n.path);
    if (!s) f.sections.push((s = { statement: "Not in export", path: n.path, what: n.what, region: n.region, checks: [] }));
    if (!s.checks.some((c) => c.standardId === n.standardId)) {
      const m = standards.mandates.find((x) => x.id === n.standardId);
      s.checks.push({ standardId: n.standardId, standardName: m?.name ?? null, severity: m?.severity ?? null, check: n.check });
    }
  }
  for (const f of byFile) {
    f.sections.sort((a, b) => a.path.localeCompare(b.path));
    for (const s of f.sections) s.checks.sort((a, b) => a.standardId.localeCompare(b.standardId));
  }

  return {
    manual: {
      statement: "Not in export",
      mandateCount: standards.mandates.length,
      manualCount: standards.manual.length,
      pillars,
    },
    byFile,
    notChecked: notChecked.map((n) => ({ statement: "Not in export", ...n })),
    notInExport: notInExport.map((n) => ({ statement: "Not in export", ...n })),
  };
}
