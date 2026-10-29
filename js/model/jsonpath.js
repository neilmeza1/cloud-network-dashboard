// Evidence paths look like $.Regions["us-east-1"].Vpcs[0].Tags

// Returns the value at `path` in `doc`, or undefined if the path does not exist.
export function resolvePath(doc, path) {
  if (typeof path !== "string" || !path.startsWith("$")) return undefined;
  const re = /\.([A-Za-z_]\w*)|\["([^"]+)"\]|\[(\d+)\]/g;
  let cur = doc, m, pos = 1;
  while ((m = re.exec(path))) {
    if (m.index !== pos) return undefined;
    pos = re.lastIndex;
    const key = m[1] ?? m[2] ?? Number(m[3]);
    if (cur === null || typeof cur !== "object" || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return pos === path.length ? cur : undefined;
}

// Pretty JSON for display. Large values are shown shallower ("[12 items]") so a
// snippet stays readable; `truncated` says when that happened.
export function snippet(value, maxLines = 40) {
  const full = JSON.stringify(value, null, 2);
  if (full === undefined) return { text: "", truncated: false };
  if (full.split("\n").length <= maxLines) return { text: full, truncated: false };
  for (const depth of [3, 2, 1]) {
    const text = JSON.stringify(shallow(value, depth), null, 2);
    if (text.split("\n").length <= maxLines) return { text, truncated: true };
  }
  const lines = JSON.stringify(shallow(value, 1), null, 2).split("\n");
  return { text: lines.slice(0, maxLines - 1).join("\n") + "\n  …", truncated: true };
}

function shallow(v, depth) {
  if (Array.isArray(v)) {
    if (depth <= 0) return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
    return v.map((x) => shallow(x, depth - 1));
  }
  if (v && typeof v === "object") {
    if (depth <= 0) return `{${Object.keys(v).length} fields}`;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shallow(x, depth - 1)]));
  }
  return v;
}
