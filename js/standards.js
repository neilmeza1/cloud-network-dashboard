// Loads ai-skills/Cloud_Standards.yaml. Thresholds come from `config`; findings map to
// mandates through each mandate's `check` id. Nothing here is hard-coded.

import { load } from "./vendor/js-yaml.mjs";

export const STANDARDS_PATH = "ai-skills/Cloud_Standards.yaml";

export function parseStandards(text) {
  const doc = load(text);
  if (!doc || typeof doc.config !== "object") {
    throw new Error(`${STANDARDS_PATH}: no config block.`);
  }
  const mandates = [];
  for (const p of doc.pillars || []) {
    for (const m of p.mandates || []) mandates.push({ ...m, pillar: p.id, pillarName: p.name });
  }
  const byCheck = new Map();
  for (const m of mandates) {
    if (m.check && m.check !== "manual") byCheck.set(m.check, m);
  }
  return {
    meta: doc.meta || {},
    config: doc.config,
    mandates,
    byCheck,
    manual: mandates.filter((m) => m.check === "manual"),
    severityOrder: Object.keys(doc.config.severity_scale || {}),
  };
}

export async function fetchStandards(base) {
  const res = await fetch(new URL(STANDARDS_PATH, base));
  if (!res.ok) throw new Error(`${STANDARDS_PATH}: HTTP ${res.status}`);
  return parseStandards(await res.text());
}
