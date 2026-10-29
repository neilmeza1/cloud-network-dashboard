// Lays out data.network_map for drawing. Pure function: no DOM, so it can be tested.
//
//   Internet bar (top, full width)
//   Transit hubs (one row, each centered over an account column)
//   Account boxes in a grid of up to `maxCols` columns, VPC nodes stacked inside
//
// Every column has a gutter on each side. Internet paths run down the left gutters and
// enter a node from the left; transit and peering paths run in the right gutters and
// enter from the right. Each path gets its own slot in a gutter, so paths never overlap,
// and paths only travel through gutters, the bus under the hubs and lanes under rows,
// so they never cross a node or another account's box.

export const GEOM = {
  nodeW: 168, nodeH: 46, nodeGap: 10, pad: 10, head: 46, footLine: 15,
  internetH: 34, hubH: 44, hubGap: 12, slot: 5, minGutter: 16, maxCols: 5, margin: 4, minWidth: 480,
};

export function layoutMap(map, g = GEOM) {
  const accounts = map.accounts;
  const cols = Math.max(1, Math.min(accounts.length, g.maxCols));
  const colOf = new Map(accounts.map((a, i) => [a.accountId, i % cols]));
  const rowOf = new Map(accounts.map((a, i) => [a.accountId, Math.floor(i / cols)]));
  const nodeAcct = new Map(map.nodes.map((n) => [n.id, n.accountId]));
  const nodeCol = (id) => colOf.get(nodeAcct.get(id));
  const nodeRow = (id) => rowOf.get(nodeAcct.get(id));

  // Gutter slots
  const left = new Array(cols).fill(0);
  const right = new Array(cols).fill(0);
  const slot = new Map();
  for (const e of map.edges) {
    if (e.kind === "internet") slot.set(e.id, left[nodeCol(e.to)]++);
    else if (e.kind === "transit") slot.set(e.id, right[nodeCol(e.from)]++);
    else if (e.kind === "peering") {
      const ca = nodeCol(e.from), cb = nodeCol(e.to);
      slot.set(`${e.id}:a`, right[ca]++);
      slot.set(`${e.id}:b`, ca === cb ? slot.get(`${e.id}:a`) : right[cb]++);
    }
  }
  const gutter = Math.max(g.minGutter, 8 + g.slot * Math.max(0, ...left, ...right));
  const boxW = g.nodeW + 2 * g.pad;
  const colW = 2 * gutter + boxW;
  // Wide enough for the internet bar's text even with a single account.
  const width = Math.max(cols * colW + 2 * g.margin, g.minWidth);
  const colLeft = (c) => g.margin + c * colW;
  const boxX = (c) => colLeft(c) + gutter;

  const internet = { x: g.margin, y: g.margin, w: width - 2 * g.margin, h: g.internetH };
  let y = internet.y + internet.h + 24;

  // Hubs: at the owner's column when free, otherwise the next free column; extra hubs wrap.
  const taken = new Set();
  const hubs = map.hubs.map((h, i) => {
    const row = Math.floor(i / cols);
    let c = colOf.has(h.ownerAccountId) ? colOf.get(h.ownerAccountId) : 0;
    while (taken.has(`${row}:${c}`)) c = (c + 1) % cols;
    taken.add(`${row}:${c}`);
    return { ...h, x: boxX(c), y: y + row * (g.hubH + g.hubGap), w: boxW, h: g.hubH, busIndex: i };
  });
  const hubRows = Math.ceil(map.hubs.length / cols);
  const hubsBottom = y + hubRows * (g.hubH + g.hubGap) - g.hubGap;
  const busY = (i) => hubsBottom + 12 + i * g.slot;
  if (hubs.length) y = busY(hubs.length - 1) + 22;

  // Account rows
  const rows = Math.ceil(accounts.length / cols);
  const lanes = new Array(rows).fill(0);
  const lane = new Map();
  for (const e of map.edges.filter((x) => x.kind === "peering")) {
    const r = Math.max(nodeRow(e.from), nodeRow(e.to));
    lane.set(e.id, { row: r, index: lanes[r]++ });
  }
  const boxes = [];
  const nodes = [];
  const rowBottom = [];
  for (let r = 0; r < rows; r++) {
    const inRow = accounts.slice(r * cols, r * cols + cols);
    const heights = inRow.map((a) => {
      const n = a.networkIds.length;
      const vpcsMissing = a.notInExport.some((x) => x.section === "Vpcs");
      const body = n ? n * (g.nodeH + g.nodeGap) - g.nodeGap : vpcsMissing ? 0 : 18;
      const foot = a.notInExport.length ? 6 + a.notInExport.length * g.footLine : 0;
      return g.head + body + g.pad + foot;
    });
    const rowH = Math.max(...heights);
    inRow.forEach((a, i) => {
      const c = colOf.get(a.accountId);
      const box = { accountId: a.accountId, x: boxX(c), y, w: boxW, h: heights[i] };
      boxes.push(box);
      a.networkIds.forEach((id, k) => {
        const nx = box.x + g.pad, ny = box.y + g.head + k * (g.nodeH + g.nodeGap);
        nodes.push({ id, accountId: a.accountId, x: nx, y: ny, w: g.nodeW, h: g.nodeH, cx: nx + g.nodeW / 2, cy: ny + g.nodeH / 2 });
      });
    });
    rowBottom[r] = y + rowH;
    y = rowBottom[r] + 24 + (lanes[r] ? 8 + lanes[r] * g.slot : 0);
  }
  const height = y - 24 + g.margin + 8;

  // Paths
  const at = new Map(nodes.map((n) => [n.id, n]));
  const hubAt = new Map(hubs.map((h) => [h.id, h]));
  const leftX = (c, s) => colLeft(c) + gutter - 6 - s * g.slot;
  const rightX = (c, s) => boxX(c) + boxW + 6 + s * g.slot;
  const perHub = new Map();
  const edges = map.edges.map((e) => {
    if (e.kind === "internet") {
      const n = at.get(e.to);
      const x = leftX(nodeCol(e.to), slot.get(e.id));
      return { ...e, points: [[x, internet.y + internet.h], [x, n.cy], [n.x, n.cy]] };
    }
    if (e.kind === "transit") {
      const n = at.get(e.from);
      const h = hubAt.get(e.to);
      const list = perHub.get(h.id) || perHub.set(h.id, map.edges.filter((x) => x.kind === "transit" && x.to === h.id)).get(h.id);
      const k = list.indexOf(e);
      const spread = Math.min(10, (h.w - 40) / Math.max(1, list.length - 1));
      const hx = h.x + h.w / 2 + (k - (list.length - 1) / 2) * spread;
      const gx = rightX(nodeCol(e.from), slot.get(e.id));
      const ey = n.cy - 7;
      const bus = busY(h.busIndex);
      return { ...e, points: [[hx, h.y + h.h], [hx, bus], [gx, bus], [gx, ey], [n.x + n.w, ey]] };
    }
    const a = at.get(e.from), b = at.get(e.to);
    const L = lane.get(e.id);
    const ly = rowBottom[L.row] + 14 + L.index * g.slot;
    const ga = rightX(nodeCol(e.from), slot.get(`${e.id}:a`));
    const gb = rightX(nodeCol(e.to), slot.get(`${e.id}:b`));
    return { ...e, points: [[a.x + a.w, a.cy + 7], [ga, a.cy + 7], [ga, ly], [gb, ly], [gb, b.cy + 7], [b.x + b.w, b.cy + 7]] };
  });

  return { width, height, cols, gutter, internet, hubs, boxes, nodes, edges };
}
