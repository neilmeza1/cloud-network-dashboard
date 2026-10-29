// Gaps: what these files cannot tell us. Renders only from data.standards_gaps.
// 1. Standards no export can verify (check: manual), with the evidence the YAML asks for.
// 2. Checks that could not run because a section is missing from an uploaded file.

import { h, stmt, sevBadge, withDef, num, clear } from "./dom.js";

const YAML = "ai-skills/Cloud_Standards.yaml";

function mandate(m) {
  return h("li", { class: "gap", "data-standard": m.id },
    h("details", null,
      h("summary", null,
        h("span", { class: "g-sev" }, sevBadge(m.severity)),
        h("span", { class: "g-id" }, m.id),
        h("span", { class: "g-name" }, m.name),
        h("span", { class: "chev", "aria-hidden": "true" }, "›")),
      h("div", { class: "gap-body" },
        h("h4", null, "Standard text"),
        h("blockquote", null, m.text, h("footer", null, `${m.id}, ${YAML}`)),
        h("h4", null, "Why it matters"),
        h("p", null, m.why),
        h("h4", null, "Evidence needed"),
        h("dl", { class: "kv" },
          h("dt", null, withDef("Enforcement", "How the standard says it is applied. Evidence that this is in place shows the standard is met.")),
          h("dd", null, m.evidence.enforcement ?? h("span", { class: "muted" }, "Not stated in the YAML")),
          h("dt", null, withDef("KPI", "Key performance indicator: the measure the standard sets for being met.")),
          h("dd", null, m.evidence.kpi ?? h("span", { class: "muted" }, "Not stated in the YAML"))))));
}

function fileBlock(f) {
  return h("li", { class: "nie-file", "data-file": f.file },
    h("h4", null, h("code", null, f.file)),
    h("ul", { class: "nie-sections" }, f.sections.map((s) =>
      h("li", { class: "nie-section", "data-path": s.key },
        h("p", null, stmt("Not in export"), " ", s.path ? h("code", null, s.path) : h("span", { class: "nie-what" }, s.what)),
        h("p", { class: "small" }, "Could not check: ",
          s.checks.map((c, i) => [i ? ", " : null, h("span", { class: "nie-check", "data-standard": c.standardId }, `${c.standardId} ${c.standardName ?? ""}`.trim())]))))));
}

export function renderGaps(el, data) {
  const g = data.standards_gaps;
  // Every item in this list is the same kind of statement, so the label sits on the heading.
  const manual = h("div", { class: "gaps-block" },
    h("h3", null, "Standards an export cannot verify ", stmt("Not in export")),
    h("p", { class: "lede" },
      num(g.manual.manualCount, "standards.manual"), " of the ", num(g.manual.mandateCount, "standards.mandates"), " ",
      withDef("mandates", "Rules in Cloud_Standards.yaml that every environment must follow (as opposed to principles, which guide design)."),
      " in ", h("code", null, YAML), " are marked ",
      withDef(h("code", null, "check: manual"), "The standard needs evidence from outside an inventory export, such as pipeline settings, access reviews or test records."),
      ". Evidence needed is quoted from each mandate's enforcement and KPI fields."),
    g.manual.pillars.map((p) => h("div", { class: "pillar", role: "group", "aria-label": p.name },
      h("h4", { class: "pillar-name" }, p.name, h("span", { class: "muted" }, ` ${p.id}`)),
      h("ul", { class: "gap-list" }, p.mandates.map(mandate)))));

  const nie = h("div", { class: "gaps-block", id: "gaps-not-in-export" },
    h("h3", null, "Checks that could not run on these files"),
    g.byFile.length
      ? [h("p", { class: "lede" }, "A section these checks read is missing from the file, so they were skipped there rather than reported as passing or failing."),
         h("ul", { class: "nie-files" }, g.byFile.map(fileBlock))]
      : h("p", { class: "lede" }, stmt("Observed"), " Every check could read the sections it needs in every uploaded file."));

  clear(el, manual, nie);
}
