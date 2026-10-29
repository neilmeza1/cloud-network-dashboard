// Findings: filters, a severity-sorted list, and expandable evidence.
// Renders only from dashboard-data (data.findings and data.standards).

import { h, stmt, sevBadge, cap, clear, num } from "./dom.js";

export const emptyFilters = () => ({ severity: "", account: "", standard: "", q: "" });

function matches(f, flt) {
  if (flt.severity && f.severity !== flt.severity) return false;
  if (flt.account && !f.accountIds.includes(flt.account)) return false;
  if (flt.standard && f.standardId !== flt.standard) return false;
  if (flt.q) {
    const hay = [f.what, f.standardId, f.standardName, f.resource.name, f.resource.id, f.region,
      ...f.accountNames, ...f.evidence.map((e) => e.file)].join(" ").toLowerCase();
    if (!flt.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
  }
  return true;
}

function select(label, value, options, onChange) {
  return h("label", null, label,
    h("select", { onchange: (e) => onChange(e.target.value) },
      options.map(([v, text]) => h("option", { value: v, selected: v === value }, text))));
}

function body(f, data) {
  const std = data.standards[f.standardId] || {};
  return [
    h("dl", { class: "kv" },
      h("dt", null, "Statement"), h("dd", null, stmt("Finding")),
      h("dt", null, "Standard"), h("dd", null, `${f.standardId} ${std.name || f.standardName}`, std.pillarName ? ` (${std.pillarName})` : ""),
      h("dt", null, f.accountNames.length > 1 ? "Accounts" : "Account"), h("dd", null, f.accountNames.join(", ")),
      f.region ? [h("dt", null, "Region"), h("dd", null, f.region)] : null,
      h("dt", null, "Resource"), h("dd", null, `${cap(f.resource.kind)} `, h("code", null, f.resource.name || f.resource.id))),
    h("h4", null, "Evidence"),
    f.evidence.map((e) => h("div", { class: "evidence" },
      h("p", null, h("span", { class: "k" }, "File"), h("code", null, e.file)),
      h("p", null, h("span", { class: "k" }, "Path"), h("code", null, e.path)),
      h("pre", { class: "snippet", tabindex: "0", "aria-label": `Raw JSON at ${e.path}` }, e.snippet),
      e.snippetShortened ? h("p", { class: "muted small" }, "Nested lists are shortened to their length. The file has the full value.") : null)),
    h("h4", null, "Why it matters"),
    h("p", null, std.why),
    h("h4", null, "Standard text"),
    h("blockquote", null, std.statement, h("footer", null, `${f.standardId}, ai-skills/Cloud_Standards.yaml`)),
    h("h4", null, "Recommended action"),
    h("p", null, f.action),
  ];
}

function row(f, i, data, expanded, onToggle) {
  const open = expanded.has(f.id);
  const bodyId = `finding-body-${i}`;
  return h("li", { class: "finding" },
    h("button", { type: "button", class: "finding-head", "data-id": f.id, "aria-expanded": String(open), "aria-controls": bodyId, onclick: () => onToggle(f.id) },
      h("span", { class: "f-sev" }, sevBadge(f.severity)),
      h("span", { class: "f-std" }, f.standardId),
      h("span", { class: "f-what" }, f.what),
      h("span", { class: "f-accts" }, f.accountNames.join(", ")),
      h("span", { class: "chev", "aria-hidden": "true" }, "›")),
    h("div", { class: "finding-body", id: bodyId, hidden: !open }, open ? body(f, data) : null));
}

export function renderFindings(el, data, state, { onFilter, onToggle }) {
  const flt = state.filters;
  const sevs = data.overview.findingsBySeverity.counts.map((c) => c.severity);
  const stds = [...new Map(data.findings.map((f) => [f.standardId, f.standardName])).entries()]
    .sort((a, b) => a[0].localeCompare(b[0]));
  const shown = data.findings.filter((f) => matches(f, flt));
  const set = (k) => (v) => onFilter({ ...flt, [k]: v });

  const filters = h("div", { class: "filters", role: "search" },
    select("Severity", flt.severity, [["", "All severities"], ...sevs.map((s) => [s, cap(s)])], set("severity")),
    select("Account", flt.account, [["", "All accounts"], ...data.meta.files.map((f) => [f.accountId, f.accountName || f.accountId])], set("account")),
    select("Standard", flt.standard, [["", "All standards"], ...stds.map(([id, name]) => [id, `${id} ${name}`])], set("standard")),
    h("label", null, "Search",
      h("input", { type: "search", value: flt.q, placeholder: "VPC, security group, file…", "data-role": "search",
        oninput: (e) => onFilter({ ...flt, q: e.target.value }, { keepFocus: true }) })),
    h("button", { type: "button", class: "reset", disabled: !Object.values(flt).some(Boolean), onclick: () => onFilter({ severity: "", account: "", standard: "", q: "" }) }, "Clear filters"));

  // The checks that could not run live in Gaps; this is only a pointer to them.
  const gaps = data.standards_gaps.notChecked.length
    ? h("p", { class: "note gaps-pointer" }, stmt("Not in export"), " Some checks could not run on these files. ",
        h("a", { href: "#gaps-not-in-export" }, "See Gaps"), ".")
    : null;

  const list = !data.findings.length
    ? h("p", { class: "empty" }, "No checks failed for these files.")
    : !shown.length
      ? h("p", { class: "empty" }, "No findings match these filters.")
      : h("ol", { class: "finding-list" }, shown.map((f, i) => row(f, i, data, state.expanded, onToggle)));

  clear(el, filters,
    h("p", { class: "result-count", "aria-live": "polite" },
      "Showing ", num(shown.length, "findings.shown", null), " of ", num(data.findings.length, "findings.total", null), ", most severe first."),
    gaps, list);
}
