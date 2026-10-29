// Browser tests for the parser and checks engine. Run with: python tests/run_tests.py
// (or serve the repo root and open tests/test.html).

import { buildModel } from "../js/model/model.js";
import { countSummary } from "../js/model/counts.js";
import { runChecks } from "../js/checks/engine.js";
import { fetchStandards } from "../js/standards.js";
import { SAMPLE_SETS, fetchSampleSet } from "../js/samples.js";

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

// Resolves a path like $.Regions["us-east-1"].Vpcs[0].Tags against a parsed document.
function resolvePath(doc, path) {
  let cur = doc;
  const re = /\.([A-Za-z_]\w*)|\["([^"]+)"\]|\[(\d+)\]/g;
  if (!path.startsWith("$")) return undefined;
  let m, pos = 1;
  while ((m = re.exec(path))) {
    if (m.index !== pos) return undefined;
    pos = re.lastIndex;
    const key = m[1] ?? m[2] ?? Number(m[3]);
    if (cur === null || typeof cur !== "object" || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return pos === path.length ? cur : undefined;
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
