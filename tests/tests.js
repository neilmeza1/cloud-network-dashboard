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
import { renderMap } from "../js/ui/map.js";
import { layoutMap } from "../js/map-layout.js";

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

  section("Map");
  const stage = document.createElement("div");
  stage.style.cssText = "position:absolute;left:-10000px;top:0;width:1200px";
  document.body.append(stage);
  const drawMap = (d, onPick = () => {}) => {
    const el = document.createElement("div");
    stage.append(el);
    renderMap(el, d, { onPickAccount: onPick });
    return el;
  };
  // Independent expectations straight from the raw files of each company.
  const rawFor = (company) => inputs.filter((i) => model.accounts.find((a) => a.file === i.path)?.company === company).map((i) => docs.get(i.path));
  const allRegions = (doc) => Object.values(doc.Regions);
  const rawExpect = (company) => {
    const ds = rawFor(company);
    const vpcs = ds.flatMap((d) => allRegions(d).flatMap((R) => R.Vpcs));
    const vpcIds = new Set(vpcs.map((v) => v.VpcId));
    const attach = new Set(ds.flatMap((d) => allRegions(d).flatMap((R) => R.TransitGatewayAttachments))
      .filter((t) => vpcIds.has(t.ResourceId)).map((t) => t.TransitGatewayAttachmentId));
    const peer = new Set(ds.flatMap((d) => allRegions(d).flatMap((R) => R.VpcPeeringConnections))
      .filter((p) => p.Status.Code === "active").map((p) => p.VpcPeeringConnectionId));
    const facing = new Set(ds.flatMap((d) => allRegions(d).flatMap((R) => [
      ...R.InternetGateways.flatMap((g) => g.Attachments.map((x) => x.VpcId)),
      ...R.LoadBalancers.filter((l) => l.Scheme === "internet-facing").map((l) => l.VpcId)])));
    return { vpcs: vpcs.length, attach: attach.size, peer: peer.size, facing: facing.size };
  };
  for (const [d, company] of [[tw, "Tidewater Payments"], [ll, "Larkspur Lending"]]) {
    const el = drawMap(d);
    const want = rawExpect(company);
    const got = { vpcs: el.querySelectorAll("g.node").length, attach: el.querySelectorAll("path.edge-transit").length,
      peer: el.querySelectorAll("path.edge-peering").length, facing: el.querySelectorAll("path.edge-internet").length };
    ok(got.vpcs === want.vpcs, `${company}: VPC nodes equal the VPC count (${got.vpcs}/${want.vpcs})`);
    ok(got.attach + got.peer === want.attach + want.peer && got.attach === want.attach,
      `${company}: lines equal unique attachments + peerings (${got.attach} transit + ${got.peer} peering; want ${want.attach} + ${want.peer})`);
    ok(got.facing === want.facing, `${company}: internet paths equal VPCs with an internet gateway or internet-facing load balancer (${got.facing}/${want.facing})`);
  }

  const twMap = drawMap(tw);
  const worstFor = (id) => standards.severityOrder.find((sv) => result.findings.some((f) => f.severity === sv && f.networkIds.includes(id))) ?? null;
  const outlineErrors = [...twMap.querySelectorAll("g.node"), ...drawMap(ll).querySelectorAll("g.node")].flatMap((g) => {
    const want = worstFor(g.dataset.vpc);
    const cls = [...g.classList].find((c) => c.startsWith("worst-"))?.slice(6) ?? null;
    const icon = g.querySelector(".sev-icon-map");
    const paired = want ? icon && icon.classList.contains(`sev-${want}`) : !icon;
    return cls === want && paired && (!want || g.getAttribute("aria-label").includes(want)) ? [] : [`${g.dataset.vpc}: outline ${cls}, want ${want}, icon ${icon?.textContent}`];
  });
  ok(outlineErrors.length === 0, "every node's outline is its worst finding, paired with an icon and the word in its label", outlineErrors.join("\n"));
  const nodeByName = (el, name) => [...el.querySelectorAll("g.node")].find((g) => g.getAttribute("aria-label").startsWith(`VPC ${name},`));
  ok(nodeByName(twMap, "tw-prod-app").classList.contains("worst-critical") && nodeByName(twMap, "tw-prod-app-dr").classList.contains("worst-medium") &&
    !/worst-/.test(nodeByName(twMap, "tw-seclog").getAttribute("class")) && !/worst-/.test(nodeByName(twMap, "tw-data-eu").getAttribute("class")),
    "spot check: tw-prod-app critical, tw-prod-app-dr medium, tw-seclog and tw-data-eu no outline (SEC-04 is region-level)");
  const dp = tw.network_map.accounts.find((a) => a.name === "tidewater-data-platform");
  const dpMarker = twMap.querySelector(`.acct-marker[data-account="${dp.accountId}"]`);
  ok(dpMarker && /▲1/.test(dpMarker.textContent), "region-level finding (SEC-04 eu-west-1) shows as a marker on its account box");

  const prodNode = nodeByName(twMap, "tw-prod-app");
  prodNode.dispatchEvent(new FocusEvent("focus"));
  const tipText = twMap.querySelector(".map-tip:not([hidden])")?.textContent || "";
  ok(["tw-prod-app", "10.20.16.0/20", "us-east-1", "us-east-1a, us-east-1b, us-east-1c", "3 public, 6 private", "1 critical", "1 medium"].every((t) => tipText.includes(t)),
    "focusing a node shows name, address range, region, zones, subnet counts and findings by severity", tipText);
  prodNode.dispatchEvent(new FocusEvent("blur"));
  ok(twMap.querySelector(".map-tip").hidden, "the tooltip hides on blur");

  let mapPicked = null;
  const llMap = drawMap(ll, (id) => { mapPicked = id; });
  const legacyNode = nodeByName(llMap, "ll-legacy-batch");
  legacyNode.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const legacyAcct = ll.network_map.nodes.find((n) => n.label === "ll-legacy-batch").accountId;
  ok(mapPicked === legacyAcct, "clicking a node asks for Findings filtered to that VPC's account");
  mapPicked = null;
  legacyNode.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  ok(mapPicked === legacyAcct, "Enter on a focused node does the same");
  const mf = document.createElement("div");
  renderFindings(mf, ll, { filters: { ...emptyFilters(), account: mapPicked }, expanded: new Set() }, { onFilter: () => {}, onToggle: () => {} });
  const legacyRows = [...mf.querySelectorAll(".finding")];
  ok(legacyRows.length === ll.findings.filter((f) => f.accountIds.includes(legacyAcct)).length && legacyRows.every((r) => r.textContent.includes("larkspur-legacy")),
    `Findings then shows only larkspur-legacy's findings (${legacyRows.length})`);

  // Not in export: a copy of tidewater-prod-app without the sections the map needs.
  const mbPath = BROKEN + "tidewater-prod-app-map-broken.json";
  const mbInputs = [{ path: mbPath, text: await fetchText(mbPath) }];
  const mbModel = buildModel(mbInputs);
  const mbData = dd(mbModel, runChecks(mbModel, standards), new Map([[mbPath, JSON.parse(mbInputs[0].text)]]), mbModel.companies[0].name);
  const mbEl = drawMap(mbData);
  const mbText = mbEl.textContent;
  ok(/Not in export/.test(mbText) && ["transit gateway attachments (us-east-1)", "internet gateways (us-east-1)", "VPCs (us-west-2)"].every((t) => mbText.includes(t)),
    "missing map sections are named as Not in export", mbText.slice(0, 300));
  ok([...mbEl.querySelectorAll(".acct .t-nie")].length === 3 &&/Not in export for tidewater-prod-app/.test(mbEl.querySelector(".internet").textContent),
    "the account box and the internet edge also say Not in export, not just an empty drawing");
  ok(mbEl.querySelectorAll("g.node").length === 1 && mbEl.querySelectorAll("path.edge-transit").length === 0,
    "only the VPC that is in the export is drawn, with no invented attachment");

  // Geometry: nothing overlaps, and lines only cross what they connect.
  const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const segHits = ([x1, y1], [x2, y2], r) => overlap({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1) || 0.01, h: Math.abs(y2 - y1) || 0.01 },
    { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 });
  const geometryProblems = (map) => {
    const Lm = layoutMap(map);
    const out = [];
    const boxOf = new Map(Lm.boxes.map((b) => [b.accountId, b]));
    const nodeAt = new Map(Lm.nodes.map((n) => [n.id, n]));
    Lm.nodes.forEach((a, i) => Lm.nodes.slice(i + 1).forEach((b) => overlap(a, b) && out.push(`nodes overlap: ${a.id} ${b.id}`)));
    Lm.boxes.forEach((a, i) => Lm.boxes.slice(i + 1).forEach((b) => overlap(a, b) && out.push(`boxes overlap: ${a.accountId} ${b.accountId}`)));
    Lm.nodes.forEach((n) => !inside(n, boxOf.get(n.accountId)) && out.push(`node outside its box: ${n.id}`));
    Lm.hubs.forEach((hb) => [...Lm.boxes, ...Lm.nodes].forEach((r) => overlap(hb, r) && out.push(`hub overlaps: ${hb.id}`)));
    for (const e of Lm.edges) {
      const ends = e.kind === "peering" ? [e.from, e.to] : [e.kind === "internet" ? e.to : e.from];
      const okRects = new Set([...ends.map((id) => nodeAt.get(id)), ...ends.map((id) => boxOf.get(nodeAt.get(id).accountId)), Lm.hubs.find((hb) => hb.id === e.to)]);
      const blockers = [...Lm.nodes, ...Lm.boxes, ...Lm.hubs].filter((r) => !okRects.has(r));
      for (let i = 1; i < e.points.length; i++) {
        for (const r of blockers) if (segHits(e.points[i - 1], e.points[i], r)) out.push(`${e.kind} ${e.id} crosses ${r.id || r.accountId}`);
      }
    }
    const segs = Lm.edges.flatMap((e) => e.points.slice(1).map((p, i) => ({ e, a: e.points[i], b: p })));
    const vertical = segs.filter((sg) => sg.a[0] === sg.b[0] && sg.a[1] !== sg.b[1]);
    vertical.forEach((p, i) => vertical.slice(i + 1).forEach((q) => {
      if (p.e !== q.e && p.a[0] === q.a[0] && Math.max(p.a[1], p.b[1]) > Math.min(q.a[1], q.b[1]) && Math.max(q.a[1], q.b[1]) > Math.min(p.a[1], p.b[1])) {
        out.push(`vertical lines on top of each other: ${p.e.id} ${q.e.id}`);
      }
    }));
    return { out, Lm };
  };
  for (const [name, d] of [["Tidewater", tw], ["Larkspur", ll]]) {
    const { out } = geometryProblems(d.network_map);
    ok(out.length === 0, `${name} layout: no overlaps, and lines only touch what they connect`, out.join("\n"));
  }
  let seed = 7;
  const rnd = (n) => { seed = (seed * 9301 + 49297) % 233280; return Math.floor((seed / 233280) * n); };
  const synth = { internet: { notInExportIn: [] }, hubs: [], edges: [], nodes: [], accounts: [] };
  for (let i = 0; i < 13; i++) {
    const nets = Array.from({ length: rnd(5) }, (_, k) => `vpc-${i}-${k}`);
    synth.accounts.push({ accountId: `a${i}`, name: `account-${i}`, role: "prod", roleStatement: "Observed", regions: ["us-east-1"],
      networkIds: nets, accountFindingsBySeverity: [], notInExport: i === 4 ? [{ section: "Vpcs", label: "VPCs", regions: ["us-west-2"] }] : [] });
    for (const id of nets) synth.nodes.push({ id, accountId: `a${i}` });
  }
  synth.hubs = [{ id: "tgw-1", ownerAccountId: "a0" }, { id: "tgw-2", ownerAccountId: "a6" }];
  synth.nodes.forEach((n, i) => {
    if (i % 3 === 0) synth.edges.push({ kind: "internet", id: `i${i}`, from: "internet", to: n.id });
    if (i % 2 === 0) synth.edges.push({ kind: "transit", id: `t${i}`, from: n.id, to: i % 4 ? "tgw-2" : "tgw-1" });
  });
  for (let k = 0; k < 6; k++) {
    const a = synth.nodes[rnd(synth.nodes.length)], b = synth.nodes[rnd(synth.nodes.length)];
    if (a.id !== b.id) synth.edges.push({ kind: "peering", id: `p${k}`, from: a.id, to: b.id });
  }
  const { out: synthOut, Lm: synthL } = geometryProblems(synth);
  ok(synthOut.length === 0 && synthL.cols === 5 && synthL.boxes.length === 13,
    `synthetic 13-account map (${synth.nodes.length} VPCs, ${synth.edges.length} lines, 2 hubs): 5 columns, no overlaps or crossings`, synthOut.slice(0, 8).join("\n"));
  stage.remove();

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
