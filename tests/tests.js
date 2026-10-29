// Browser tests for the parser and checks engine. Run with: python tests/run_tests.py
// (or serve the repo root and open tests/test.html).

import { buildModel } from "../js/model/model.js";
import { countSummary } from "../js/model/counts.js";
import { runChecks } from "../js/checks/engine.js";
import { fetchStandards } from "../js/standards.js";
import { SAMPLE_SETS, fetchSampleSet } from "../js/samples.js";
import { resolvePath } from "../js/model/jsonpath.js";
import { buildDashboardData } from "../js/dashboard-data.js";
import { renderOverview } from "../js/ui/overview.js";
import { renderFindings, emptyFilters } from "../js/ui/findings.js";
import { renderAccounts } from "../js/ui/accounts.js";

const BASE = new URL("../", import.meta.url);
const BROKEN = "tests/fixtures/broken/";
const lines = [];
let passed = 0, failed = 0;

function ok(cond, name, detail = "") {
  cond ? passed++ : failed++;
  lines.push(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `\n      ${detail.replace(/\n/g, "\n      ")}` : ""}`);
}
const section = (t) => lines.push("", `## ${t}`);

async function fetchText(path) {
  const res = await fetch(new URL(path, BASE));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.text();
}
const base = (p) => p.split("/").pop();

// Rows of samples/EXPECTED_FINDINGS.md as [{ file, standard, check, text }].
function parseAnswerKey(md) {
  const rows = [];
  let file = null;
  for (const line of md.split(/\r?\n/)) {
    const h = /^## (.+\.json)\s*$/.exec(line);
    if (h) { file = h[1]; continue; }
    const r = /^\|\s*([A-Z]{3}-\d+)\s*\|\s*`([a-z_]+)`\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (r && file) rows.push({ file, standard: r[1], check: r[2], text: r[3] });
  }
  return rows;
}

// Multiset diff of "file | standard | check" keys.
function diffKeys(expected, actual) {
  const count = (keys) => keys.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
  const e = count(expected), a = count(actual);
  const missing = [], extra = [];
  for (const [k, n] of e) for (let i = (a.get(k) || 0); i < n; i++) missing.push(k);
  for (const [k, n] of a) for (let i = (e.get(k) || 0); i < n; i++) extra.push(k);
  return { missing, extra };
}
// A finding counts once for every file it cites (a peering or an overlap cites both sides).
const findingKeys = (findings) =>
  findings.flatMap((f) => f.files.map((file) => `${base(file)} | ${f.standardId} | ${f.check}`));

async function main() {
  const standards = await fetchStandards(BASE);
  const awsPaths = [...SAMPLE_SETS.tidewater.files, ...SAMPLE_SETS.larkspur.files];
  const inputs = [...await fetchSampleSet("tidewater", BASE), ...await fetchSampleSet("larkspur", BASE)];
  const model = buildModel(inputs);
  const result = runChecks(model, standards);
  const docs = new Map(inputs.map((i) => [i.path, JSON.parse(i.text)]));

  section("Standards");
  ok(standards.byCheck.size === 15, `Cloud_Standards.yaml has 15 detectable checks (found ${standards.byCheck.size})`);
  ok(result.errors.length === 0, "every detectable check in the YAML is implemented", result.errors.map((e) => e.message).join("\n"));

  section("AWS findings vs samples/EXPECTED_FINDINGS.md");
  const awsFiles = new Set(awsPaths.map(base));
  const key = parseAnswerKey(await fetchText("samples/EXPECTED_FINDINGS.md")).filter((r) => awsFiles.has(r.file));
  ok(key.length === 28, `answer key has 28 AWS rows (found ${key.length})`);
  ok(model.errors.length === 0, "all 7 AWS sample files parse", model.errors.map((e) => e.message).join("\n"));
  const { missing, extra } = diffKeys(key.map((r) => `${r.file} | ${r.standard} | ${r.check}`), findingKeys(result.findings));
  ok(missing.length === 0, `every answer-key row is reported (${key.length - missing.length}/${key.length})`, "missing: " + missing.join("\n         "));
  ok(extra.length === 0, "nothing reported beyond the answer key", "extra: " + extra.join("\n       "));
  ok(result.notChecked.length === 0, "no check was skipped for a missing section in the clean samples",
    result.notChecked.map((n) => `${n.standardId} ${n.file} ${n.path}`).join("\n"));

  section("Every finding is complete and its evidence path exists");
  const incomplete = result.findings.filter((f) =>
    !f.severity || !f.standardId || !f.what || !f.evidence.length || f.evidence.some((e) => !e.file || !e.path));
  ok(incomplete.length === 0, `all ${result.findings.length} findings have severity, standard ID, description, file and path`,
    incomplete.map((f) => f.id).join("\n"));
  const unresolved = result.findings.flatMap((f) => f.evidence.filter((e) => resolvePath(docs.get(e.file), e.path) === undefined)
    .map((e) => `${f.id}: ${e.file} ${e.path}`));
  ok(unresolved.length === 0, "every evidence path resolves to a value in its file", unresolved.join("\n"));
  const sevs = standards.severityOrder;
  ok(result.findings.every((f, i, a) => !i || sevs.indexOf(a[i - 1].severity) <= sevs.indexOf(f.severity)), "findings are sorted by severity");

  section("Thresholds come from config");
  const tweak = (patch) => runChecks(model, { ...standards, config: { ...standards.config, ...patch } }).findings;
  ok(!tweak({ admin_ports: [3389] }).some((f) => f.standardId === "NET-06"),
    "admin_ports without 22: no NET-06 findings (all planted admin rules are SSH)");
  ok(!tweak({ approved_regions: { ...standards.config.approved_regions, aws: ["us-east-1", "us-west-2", "us-east-2", "eu-west-1"] } })
    .some((f) => f.standardId === "SEC-04"), "approved_regions extended: no SEC-04 findings");
  ok(tweak({ min_azs_for_prod: 3 }).filter((f) => f.standardId === "RES-01").length > 1,
    "min_azs_for_prod: 3 flags more production VPCs than the default of 2");

  section("Not in export (tests/fixtures/broken/)");
  const brokenPath = BROKEN + "larkspur-prod-broken.json";
  const brokenInputs = await Promise.all(["larkspur-prod-broken.json", "unknown-schema.json", "not-json.json"]
    .map(async (f) => ({ path: BROKEN + f, text: await fetchText(BROKEN + f) })));
  const bm = buildModel(brokenInputs);
  const br = runChecks(bm, standards);
  const nie = bm.notInExport.map((n) => n.path);
  for (const p of ['$.Account.Tags', '$.Regions["us-east-1"].FlowLogs', '$.Regions["us-east-1"].VpcEndpoints',
    '$.Regions["us-east-1"].WebAclResources', '$.Global']) {
    ok(nie.includes(p), `normalizer records ${p} as not in export`, `recorded: ${nie.join(", ")}`);
  }
  const blocked = ["NET-01", "NET-10", "NET-08", "NET-05"];
  for (const s of blocked) {
    ok(!br.findings.some((f) => f.standardId === s), `${s} produces no finding when its section is missing`);
    ok(br.notChecked.some((n) => n.standardId === s && n.file === brokenPath), `${s} is listed as not checked (not in export)`);
  }
  const survivors = br.findings.map((f) => f.standardId).sort();
  const wantSurvivors = ["DAT-01", "NET-04", "NET-07", "NET-07", "NET-09", "NET-11", "OPS-01"];
  ok(JSON.stringify(survivors) === JSON.stringify(wantSurvivors), "checks whose sections are present still report their findings",
    `got ${survivors.join(", ")}\nwant ${wantSurvivors.join(", ")}`);
  const counts = countSummary(bm).companies[0].accounts[0].counts;
  for (const k of ["activeFlowLogs", "endpoints", "cdnDistributions"]) {
    ok(counts[k] === null, `count ${k} is "not in export", not 0 (got ${counts[k]})`);
  }
  ok(counts.vpcs === 1 && counts.listeners === 2, "counts for sections that are present are unchanged");
  const errFor = (f) => bm.errors.find((e) => e.file === BROKEN + f);
  ok(/unknown schema "oracle-tenancy-inventory\/1\.0"/.test(errFor("unknown-schema.json")?.message || "") &&
    errFor("unknown-schema.json").message.includes("unknown-schema.json"), "unknown schema gives an error naming the file",
    errFor("unknown-schema.json")?.message);
  ok(/not-json\.json: not valid JSON/.test(errFor("not-json.json")?.message || ""), "invalid JSON gives an error naming the file",
    errFor("not-json.json")?.message);
  ok(bm.files.length === 1, "a bad file does not stop the good one from loading");

  section("dashboard-data and rendering");
  const dd = (m, r, docMap, company) => buildDashboardData({ model: m, checks: r, standards, docs: docMap, company });
  const tw = dd(model, result, docs, "Tidewater Payments");
  const ll = dd(model, result, docs, "Larkspur Lending");
  ok(JSON.stringify(Object.keys(tw)) === JSON.stringify(["meta", "overview", "findings", "network_map", "accounts", "standards_gaps", "standards"]),
    "dashboard-data parts are in the order the analyze-cloud-export contract lists");
  ok(tw.findings.length === 8 && ll.findings.length === 18, `findings split by company: Tidewater ${tw.findings.length} (want 8), Larkspur ${ll.findings.length} (want 18)`);
  const tile = (d, key, item) => d.overview.tiles.find((t) => t.key === key).items.find((i) => i.key === item).value;
  ok(tile(tw, "accounts", "accounts") === 5 && tile(tw, "vpcs", "vpcs") === 9 && tile(tw, "subnets", "subnets") === 44 &&
    tile(tw, "connectivity", "transitAttachments") === 5 && tile(ll, "connectivity", "peerings") === 1,
    "overview tiles carry the step 1 company totals");
  ok(tw.overview.tiles.length === 5 && tw.overview.findingsBySeverity.counts.map((c) => c.count).join() === "1,4,3,0",
    "five count tiles plus severity counts (critical 1, high 4, medium 3, low 0 for Tidewater)");
  ok(tw.overview.tiles.every((t) => t.definition) && tw.overview.tiles.every((t) => t.items.every((i) => i.definition)),
    "every tile and tile item has a definition");
  ok(tw.findings.every((f) => f.statement === "Finding" && f.evidence.every((e) => e.snippet && !e.snippet.startsWith("(path not found")))
    && tw.findings.every((f) => tw.standards[f.standardId]?.statement), "every finding has a raw snippet and the standard's text from the YAML");
  const bdocs = new Map(brokenInputs.flatMap((i) => { try { return [[i.path, JSON.parse(i.text)]]; } catch { return []; } }));
  const bd = dd(bm, br, bdocs, bm.companies[0].name);
  const cdn = bd.overview.tiles.find((t) => t.key === "internet").items.find((i) => i.key === "cdnDistributions");
  ok(cdn.value === null && cdn.statement === "Not in export", "a tile item whose section is missing says Not in export");
  ok(bd.standards_gaps.notChecked.length > 0 && bd.standards_gaps.notChecked.every((n) => n.statement === "Not in export"),
    "checks that could not run are carried as Not in export");

  // Company grouping: by folder; files picked without a folder group by the export's company name.
  const loose = buildModel(inputs.map((i) => ({ path: base(i.path), text: i.text })));
  ok(loose.companies.map((c) => `${c.name}:${c.accountIds.length}`).join() === "Tidewater Payments:5,Larkspur Lending:2",
    "files without a folder group by Account.Company");
  const moved = buildModel(inputs.map((i) => ({ path: `acquired/${base(i.path)}`, text: i.text })));
  ok(moved.companies.length === 1 && moved.companies[0].name === "acquired",
    "one folder is one company, named after the folder when the files disagree on Company");
  const twice = buildModel([...inputs.slice(0, 1), { path: "copy/" + base(inputs[0].path), text: inputs[0].text }]);
  ok(twice.accounts.length === 1 && /same account/.test(twice.errors[0]?.message || ""), "the same account uploaded twice is counted once, with an error");

  // Renderers, into detached elements.
  const ov = document.createElement("div");
  renderOverview(ov, tw, { onPickSeverity: () => {} });
  ok(ov.querySelectorAll(".tile").length === 6 && ov.querySelectorAll(".tile-def").length === 6, "overview renders six tiles, each with a definition");
  const fl = document.createElement("div");
  const st = { filters: { ...emptyFilters(), severity: "high" }, expanded: new Set() };
  const draw = () => renderFindings(fl, ll, st, { onFilter: (f) => { st.filters = f; draw(); }, onToggle: (id) => { st.expanded.add(id); draw(); } });
  draw();
  ok(fl.querySelectorAll(".finding").length === 9, `severity filter "high" shows the 9 high Larkspur findings (got ${fl.querySelectorAll(".finding").length})`);
  st.filters = { ...emptyFilters(), q: "ll-legacy-batch flow" };
  draw();
  ok(fl.querySelectorAll(".finding").length === 1, "search matches all words: 'll-legacy-batch flow' finds one finding");
  st.filters = { ...emptyFilters(), standard: "NET-07", account: "880310000001" };
  draw();
  ok(fl.querySelectorAll(".finding").length === 2, "standard + account filters combine (NET-07 in larkspur-prod: 2)");
  fl.querySelector(".finding-head").click();
  const opened = fl.querySelector(".finding-body:not([hidden])");
  ok(opened && opened.querySelector("pre.snippet") && /ai-skills\/Cloud_Standards\.yaml/.test(opened.textContent) && /\$\.Regions/.test(opened.textContent),
    "expanding a finding shows file, path, raw snippet and the standard text");
  ok(!fl.textContent.includes("null") && !ov.textContent.includes("null") && !ov.textContent.includes("undefined"), "no stray null or undefined in rendered text");

  section("Accounts");
  const stepOne = new Map(countSummary(model).companies.flatMap((c) => c.accounts).map((a) => [a.id, a.counts]));
  const drawAccounts = (d, st, cb = {}) => {
    const el = document.createElement("div");
    const redraw = () => renderAccounts(el, d, st, { onToggle: (id) => { st.expanded.add(id); redraw(); }, onPickAccount: cb.onPick || (() => {}) });
    redraw();
    return el;
  };
  const twEl = drawAccounts(tw, { expanded: new Set() });
  const llEl = drawAccounts(ll, { expanded: new Set() });
  const rowsOf = (el) => [...el.querySelectorAll("tr.acct-row")];
  ok(rowsOf(twEl).length === 5 && rowsOf(llEl).length === 2 && !/TOTAL/i.test(twEl.textContent),
    "one row per account, no company total row");
  const cellMismatches = [];
  for (const [el, d] of [[twEl, tw], [llEl, ll]]) {
    rowsOf(el).forEach((tr, i) => {
      const id = d.accounts.rows[i].accountId;
      for (const td of tr.querySelectorAll("td[data-key]")) {
        const want = String(stepOne.get(id)[td.dataset.key]);
        if (td.textContent.trim() !== want) cellMismatches.push(`${d.accounts.rows[i].name} ${td.dataset.key}: shows ${td.textContent.trim()}, step 1 says ${want}`);
      }
    });
  }
  ok(cellMismatches.length === 0, "every per-account number in the table matches the step 1 counts", cellMismatches.join("\n"));
  const cells = (el, name) => Object.fromEntries([...rowsOf(el).find((tr) => tr.textContent.includes(name)).querySelectorAll("td[data-key]")]
    .map((td) => [td.dataset.key, td.textContent.trim()]));
  ok(JSON.stringify(cells(twEl, "tidewater-prod-app")) === JSON.stringify({ vpcs: "2", subnets: "15", endpoints: "7", natGateways: "3", interfaces: "22" }) &&
    JSON.stringify(cells(llEl, "larkspur-legacy")) === JSON.stringify({ vpcs: "1", subnets: "1", endpoints: "0", natGateways: "0", interfaces: "2" }),
    "spot check against the generator's table: tidewater-prod-app 2/15/7/3/22, larkspur-legacy 1/1/0/0/2");
  ok(twEl.querySelectorAll("thead th .def-pop").length === tw.accounts.columns.length, "every column header has a hover definition");

  const prod = tw.accounts.rows.find((r) => r.name === "tidewater-prod-app");
  twEl.querySelector(`.acct-toggle[data-account="${prod.accountId}"]`).click();
  const openDetail = twEl.querySelector("tr.acct-detail:not([hidden])");
  const wantVpcs = model.networks.filter((n) => n.accountId === prod.accountId);
  ok(openDetail && openDetail.querySelectorAll("article.vpc").length === wantVpcs.length &&
    wantVpcs.every((n) => openDetail.textContent.includes(n.name) && n.cidrs.every((c) => openDetail.textContent.includes(c))),
    `expanding tidewater-prod-app shows its ${wantVpcs.length} VPCs with name and address range`,
    openDetail ? openDetail.textContent.slice(0, 200) : "no open detail row");
  const shownVpcIds = [...openDetail.querySelectorAll("article.vpc")].map((a) => a.dataset.vpc).sort();
  ok(JSON.stringify(shownVpcIds) === JSON.stringify(wantVpcs.map((n) => n.id).sort()), "the expanded row shows only that account's VPCs");
  const split = prod.networks.reduce((s, n) => s + n.subnets.public.length + n.subnets.private.length, 0);
  ok(split === stepOne.get(prod.accountId).subnets && /Public subnets/.test(openDetail.textContent) && /Private subnets/.test(openDetail.textContent),
    "subnets are split into public and private, and add up to the account's subnet count");
  ok(["Default routes", "VPC endpoints", "NAT gateways per zone", "Network interfaces"].every((t) => openDetail.textContent.includes(t)) &&
    /us-east-1b: none/.test(openDetail.textContent), "detail shows default routes, endpoints, NAT gateways per zone (tw-prod-app has none in 1b) and interfaces");

  let picked = null;
  const llPick = drawAccounts(ll, { expanded: new Set() }, { onPick: (id) => { picked = id; } });
  const lp = ll.accounts.rows.find((r) => r.name === "larkspur-prod");
  llPick.querySelector(`.sev-marker[data-account="${lp.accountId}"]`).click();
  ok(picked === lp.accountId, "clicking an account's severity marker asks for Findings filtered to that account");
  const fEl = document.createElement("div");
  renderFindings(fEl, ll, { filters: { ...emptyFilters(), account: picked }, expanded: new Set() }, { onFilter: () => {}, onToggle: () => {} });
  const markerTotal = lp.findingsBySeverity.reduce((n, s) => n + s.count, 0);
  const fRows = [...fEl.querySelectorAll(".finding")];
  ok(fRows.length === markerTotal && fRows.every((r) => r.textContent.includes("larkspur-prod")) &&
    fEl.querySelector("select:nth-of-type(1)") !== null && [...fEl.querySelectorAll("select")][1].value === lp.accountId,
    `Findings then shows exactly that account's ${markerTotal} findings, with the account filter set`);
  ok(rowsOf(twEl).filter((tr) => tr.lastElementChild.textContent.trim() === "None").length === 2,
    "accounts without findings show None instead of a marker (2 in Tidewater)");

  const bEl = drawAccounts(bd, { expanded: new Set() });
  const bCells = cells(bEl, "larkspur-prod");
  ok(bCells.endpoints === "Not in export" && bCells.vpcs === "1", `missing VpcEndpoints shows "Not in export", not 0 (shows ${bCells.endpoints})`);
  ok(/Not in export/.test(rowsOf(bEl)[0].querySelector('td[data-label="Role"]').textContent), "missing account tags: role says Not in export");
  bEl.querySelector(".acct-toggle").click();
  const bDetail = bEl.querySelector("tr.acct-detail:not([hidden])");
  const epPart = [...bDetail.querySelectorAll(".vpc-part")].find((p) => p.querySelector("h5").textContent === "VPC endpoints");
  ok(epPart && /Not in export/.test(epPart.textContent) && !/\b0\b/.test(epPart.textContent), "expanded VPC says endpoints are Not in export");

  // Reference listing: what the engine reported for the clean AWS samples.
  lines.push("", "## Findings reported for the AWS samples", "");
  for (const f of result.findings) {
    lines.push(`${f.severity.toUpperCase().padEnd(8)} ${f.standardId}  ${f.files.map(base).join(" + ")}`, `         ${f.what}`);
  }
}

main().catch((e) => { failed++; lines.push(`FAIL  test run crashed: ${e.stack || e}`); }).finally(() => {
  lines.push("", `RESULT: ${failed ? "FAIL" : "PASS"} (${passed} passed, ${failed} failed)`);
  const out = document.getElementById("results");
  out.textContent = lines.join("\n").trimStart();
  document.body.dataset.result = failed ? "fail" : "pass";
});
