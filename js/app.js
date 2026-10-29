// Page controller: load files -> model -> checks -> dashboard-data -> render.
// Rendering reads only the dashboard-data object.

import { buildModel } from "./model/model.js";
import { runChecks } from "./checks/engine.js";
import { fetchStandards } from "./standards.js";
import { buildDashboardData } from "./dashboard-data.js";
import { SAMPLE_SETS, fetchSampleSet } from "./samples.js";
import { fromFileList, fromDrop } from "./ui/upload.js";
import { renderOverview } from "./ui/overview.js";
import { renderFindings, emptyFilters } from "./ui/findings.js";
import { renderAccounts } from "./ui/accounts.js";
import { renderMap } from "./ui/map.js";
import { renderGaps } from "./ui/gaps.js";
import { h } from "./ui/dom.js";
import { initTheme } from "./ui/theme.js";

const $ = (id) => document.getElementById(id);
const BASE = new URL("./", location.href);
const state = {
  standards: null, inputs: [], docs: new Map(), model: null, checks: null,
  company: null, data: null, filters: emptyFilters(), expanded: new Set(), openAccounts: new Set(),
};

const fresh = () => ({ filters: emptyFilters(), expanded: new Set(), openAccounts: new Set() });

// Show Findings filtered to one account (from an Accounts severity marker).
function showAccountFindings(accountId) {
  state.filters = { ...emptyFilters(), account: accountId };
  renderFindingsSection();
  $("findings").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderAccountsSection() {
  renderAccounts($("accounts-body"), state.data, { expanded: state.openAccounts }, {
    onToggle: (id) => {
      state.openAccounts.has(id) ? state.openAccounts.delete(id) : state.openAccounts.add(id);
      renderAccountsSection();
      document.querySelector(`.acct-toggle[data-account="${CSS.escape(id)}"]`)?.focus();
    },
    onPickAccount: showAccountFindings,
  });
}

function status(...kids) {
  $("load-status").replaceChildren(...kids);
}

function errorList(title, items) {
  return h("div", { class: "errors", role: "alert" }, h("p", null, h("strong", null, title)), h("ul", null, items.map((t) => h("li", null, t))));
}

async function load(inputs, { ignored = [], scroll = true } = {}) {
  if (!inputs.length) {
    status(errorList("No JSON files found.", ignored.length ? [`Ignored (not .json): ${ignored.join(", ")}`] : ["Pick .json export files or a folder that contains them."]));
    return;
  }
  const docs = new Map();
  for (const i of inputs) {
    try { docs.set(i.path, JSON.parse(i.text)); } catch { /* buildModel reports it */ }
  }
  const model = buildModel(inputs);
  Object.assign(state, {
    inputs, docs, model, checks: runChecks(model, state.standards),
    company: model.companies[0]?.name ?? null, ...fresh(),
  });
  const notes = [];
  if (model.errors.length) notes.push(errorList("Some files could not be read:", model.errors.map((e) => e.message)));
  if (ignored.length) notes.push(h("p", { class: "muted small" }, `Ignored (not .json): ${ignored.join(", ")}`));
  if (model.companies.length) {
    notes.unshift(h("p", null, "Loaded ", model.companies.map((c) => c.name).join(", "), ". ",
      h("details", { class: "file-list" }, h("summary", null, "Files"),
        h("ul", null, model.files.map((f) => h("li", null, h("code", null, f.file)))))));
  }
  status(...notes);
  rebuild();
  if (scroll && state.data) $("overview").scrollIntoView({ behavior: "smooth", block: "start" });
}

function rebuild() {
  state.data = state.model && state.company
    ? buildDashboardData({ model: state.model, checks: state.checks, standards: state.standards, docs: state.docs, company: state.company })
    : null;
  document.body.classList.toggle("has-data", !!state.data);
  render();
}

function render() {
  const data = state.data;
  $("download-btn").disabled = !data;
  const pick = document.querySelector(".company-pick");
  const companies = state.model?.companies || [];
  $("company-name").textContent = data ? data.meta.company : "Cloud Network Dashboard";
  $("company-name").hidden = companies.length > 1;
  pick.hidden = companies.length <= 1;
  if (companies.length > 1) {
    $("company-select").replaceChildren(...companies.map((c) => h("option", { value: c.name, selected: c.name === state.company }, c.name)));
  }
  document.title = data ? `${data.meta.company} · Cloud Network Dashboard` : "Cloud Network Dashboard";
  if (!data) {
    renderEmpty(!!state.model);
    return;
  }
  renderOverview($("overview-body"), data, {
    onPickSeverity: (severity) => {
      state.filters = { ...emptyFilters(), severity };
      renderFindingsSection();
      $("findings").scrollIntoView({ behavior: "smooth", block: "start" });
    },
  });
  renderFindingsSection();
  renderMap($("map-body"), data, { onPickAccount: showAccountFindings });
  renderAccountsSection();
  renderGaps($("gaps-body"), data);
}

// Nothing to show: either nothing is loaded yet, or every file failed to read. Earlier results
// are cleared so a failed upload never leaves another company's dashboard on screen.
const EMPTY = {
  "overview-body": "the overview", "findings-body": "findings", "map-body": "the network map",
  "accounts-body": "each account", "gaps-body": "what the files cannot show",
};
function renderEmpty(attempted) {
  for (const [id, what] of Object.entries(EMPTY)) {
    $(id).replaceChildren(attempted
      ? h("p", { class: "empty" }, "None of the files could be read, so there is nothing to show. ", h("a", { href: "#load" }, "See the errors"), ".")
      : h("p", { class: "empty" }, `Load files to see ${what}.`));
  }
}

function renderFindingsSection(opts = {}) {
  const search = document.querySelector('[data-role="search"]');
  const caret = opts.keepFocus && search ? search.selectionStart : null;
  renderFindings($("findings-body"), state.data, state, {
    onFilter: (filters, o) => { state.filters = filters; renderFindingsSection(o); },
    onToggle: (id) => {
      state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
      renderFindingsSection();
      [...document.querySelectorAll(".finding-head")].find((b) => b.dataset.id === id)?.focus();
    },
  });
  if (caret !== null) {
    const s = document.querySelector('[data-role="search"]');
    s.focus();
    s.setSelectionRange(caret, caret);
  }
}

function download() {
  const blob = new Blob([JSON.stringify(state.data, null, 2) + "\n"], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: "dashboard-data.json" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function wire() {
  initTheme($("theme-btn"));
  $("upload-btn").addEventListener("click", () => {
    $("load").scrollIntoView({ behavior: "smooth", block: "start" });
    $("pick-files").focus({ preventScroll: true });
  });
  $("download-btn").addEventListener("click", download);
  $("company-select").addEventListener("change", (e) => {
    Object.assign(state, { company: e.target.value, ...fresh() });
    rebuild();
  });
  $("pick-files").addEventListener("click", () => $("file-input").click());
  $("pick-folder").addEventListener("click", () => $("folder-input").click());
  for (const id of ["file-input", "folder-input"]) {
    $(id).addEventListener("change", async (e) => {
      const { inputs, ignored } = await fromFileList(e.target.files);
      e.target.value = "";
      load(inputs, { ignored });
    });
  }
  for (const b of document.querySelectorAll("[data-sample]")) {
    b.addEventListener("click", () => loadSample(b.dataset.sample));
  }
  const dz = $("dropzone");
  const over = (on) => (e) => { e.preventDefault(); dz.classList.toggle("over", on); };
  dz.addEventListener("dragenter", over(true));
  dz.addEventListener("dragover", over(true));
  dz.addEventListener("dragleave", over(false));
  dz.addEventListener("drop", async (e) => {
    over(false)(e);
    const { inputs, ignored } = await fromDrop(e.dataTransfer);
    load(inputs, { ignored });
  });
  // A file dropped outside the drop zone must not navigate away from the page.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}

async function loadSample(key, opts) {
  status(h("p", null, `Loading ${SAMPLE_SETS[key].label}…`));
  try {
    await load(await fetchSampleSet(key, BASE), opts);
  } catch (e) {
    status(errorList("Could not load the sample.", [String(e.message || e)]));
  }
}

async function init() {
  wire();
  try {
    state.standards = await fetchStandards(BASE);
  } catch (e) {
    status(errorList("Could not load the standards file, so no checks can run.", [String(e.message || e),
      "Serve the folder over http (for example: python -m http.server) instead of opening index.html directly."]));
    document.querySelectorAll("#load button").forEach((b) => (b.disabled = true));
    return;
  }
  // ?sample=tidewater|larkspur loads a sample on open; &expand=N opens the first N findings;
  // &accounts=N opens the first N account rows; &gaps=N opens the first N standards in Gaps.
  // ?sample=broken loads the broken test fixtures.
  const params = new URLSearchParams(location.search);
  const sample = params.get("sample");
  if (sample && SAMPLE_SETS[sample]) {
    await loadSample(sample, { scroll: false });
    const n = Number(params.get("expand") || 0);
    const a = Number(params.get("accounts") || 0);
    const g = Number(params.get("gaps") || 0);
    if (state.data) {
      state.data.findings.slice(0, n).forEach((f) => state.expanded.add(f.id));
      state.data.accounts.rows.slice(0, a).forEach((r) => state.openAccounts.add(r.accountId));
      if (n) renderFindingsSection();
      if (a) renderAccountsSection();
      [...document.querySelectorAll("#gaps details")].slice(0, g).forEach((d) => (d.open = true));
    }
  }
  document.body.dataset.ready = "true";
}

init();
