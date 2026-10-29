// Check implementations, keyed by the `check` id used in Cloud_Standards.yaml.
// Each check reads the normalized model and calls ctx.report(...) once per finding.
//
// needs: export sections the check reads. Where a section is missing, the engine records
// "not checked: not in export" for that scope and ctx.can(record) returns false for records
// in it, so a missing section never turns into a finding.
//   region:  sections inside Regions.<region>
//   global:  sections inside Global (records with region "global")
//   account: fields of Account

const isTcp = (r) => r.protocol === "tcp" || r.protocol === "6";
const covers = (r, port) => r.fromPort !== null && r.fromPort <= port && port <= r.toPort;
const coveredPorts = (r, ports) => (isTcp(r) ? ports.filter((p) => covers(r, p)) : []);
const worldIngress = (m, ctx) => m.firewallRules.filter((r) => r.direction === "ingress" && r.fromWorld && ctx.can(r));
const portText = (r) => (r.protocol === "all" ? "all traffic" : r.fromPort === r.toPort ? `${r.protocol} ${r.fromPort}` : `${r.protocol} ${r.fromPort}-${r.toPort}`);

export function networkLabel(n) {
  if (!n) return "unknown VPC";
  if (n.name) return n.name;
  return n.isDefault ? `default (${n.id})` : n.id;
}

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

function ipv4Range(cidr) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr || "");
  if (!m) return null;
  const ip = ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4];
  const size = 2 ** (32 - +m[5]);
  const start = Math.floor(ip / size) * size;
  return [start, start + size - 1];
}

// Report one finding per security group, listing the offending rules.
function reportGroups(m, ctx, rules, describe) {
  for (const [, rs] of groupBy(rules, (r) => r.groupId)) {
    const sg = rs[0];
    ctx.report({
      record: sg, resource: { kind: "security group", id: sg.groupId, name: sg.groupName },
      what: describe(sg, rs), evidence: rs.map((r) => r.src),
    });
  }
}

export const CHECKS = {
  account_role_tag_present: {
    needs: { account: ["Tags"] },
    action: "Tag the account with its AccountRole, or re-vend it from the approved baseline.",
    run(m, ctx) {
      for (const a of m.accounts) {
        if (!ctx.can(a) || a.role) continue;
        ctx.report({
          record: a, accountIds: [a.id], resource: { kind: "account", id: a.id, name: a.name },
          what: `Account ${a.name || a.id} has no AccountRole tag`,
          evidence: [{ file: a.file, path: `${a.src.path}.Tags` }],
        });
      }
    },
  },

  default_network_present: {
    needs: { region: ["Vpcs"] },
    action: "Delete the default VPC, or keep it empty and unrouted.",
    run(m, ctx) {
      for (const n of m.networks.filter((n) => n.isDefault && ctx.can(n))) {
        ctx.report({
          record: n, resource: { kind: "VPC", id: n.id, name: networkLabel(n) },
          what: `Default VPC ${n.id} (${n.cidrs.join(", ")}) exists in ${n.region}`, evidence: [n.src],
        });
      }
    },
  },

  cidr_overlap: {
    needs: { region: ["Vpcs"] },
    action: "Renumber one of the networks from the central address plan before connecting them.",
    run(m, ctx) {
      for (const co of m.companies) {
        const ids = new Set(co.accountIds);
        const nets = m.networks.filter((n) => ids.has(n.accountId) && ctx.can(n));
        for (let i = 0; i < nets.length; i++) {
          for (let j = i + 1; j < nets.length; j++) {
            const a = nets[i], b = nets[j];
            for (const ca of a.cidrs) for (const cb of b.cidrs) {
              const ra = ipv4Range(ca), rb = ipv4Range(cb);
              if (!ra || !rb || ra[1] < rb[0] || rb[1] < ra[0]) continue;
              const fa = ctx.account(a).file.split("/").pop(), fb = ctx.account(b).file.split("/").pop();
              ctx.report({
                record: a, accountIds: [a.accountId, b.accountId], networkIds: [a.id, b.id],
                resource: { kind: "VPC pair", id: `${a.id}+${b.id}`, name: `${networkLabel(a)} / ${networkLabel(b)}` },
                what: `VPC ${networkLabel(a)} (${ca}) in ${fa} overlaps VPC ${networkLabel(b)} (${cb}) in ${fb}`,
                evidence: [a.src, b.src],
              });
            }
          }
        }
      }
    },
  },

  workload_in_public_subnet: {
    needs: { region: ["NetworkInterfaces"] },
    action: "Move the workloads behind a load balancer in private subnets and remove their public IPs.",
    run(m, ctx) {
      const hits = m.interfaces.filter((e) => e.role === "workload" && e.publicIp && ctx.can(e));
      for (const [netId, es] of groupBy(hits, (e) => e.networkId)) {
        const n = m.networks.find((x) => x.id === netId);
        ctx.report({
          record: es[0], resource: { kind: "VPC", id: netId, name: networkLabel(n) },
          what: `${es.length} workload interface${es.length > 1 ? "s" : ""} in VPC ${networkLabel(n)} ${es.length > 1 ? "have" : "has"} public IP addresses (${es.map((e) => `${e.id} ${e.publicIp}`).join(", ")})`,
          evidence: es.map((e) => e.src),
        });
      }
    },
  },

  public_endpoint_without_waf: {
    needs: { region: ["LoadBalancers", "WebAclResources"], global: ["CloudFrontDistributions"] },
    action: "Associate the baseline web application firewall (WAF) rule set with the endpoint.",
    run(m, ctx) {
      for (const lb of m.loadBalancers.filter((l) => l.internetFacing && ctx.can(l))) {
        if (lb.wafAclArn) continue;
        ctx.report({
          record: lb, resource: { kind: "load balancer", id: lb.id, name: lb.name },
          what: `Internet-facing load balancer ${lb.name} is not associated with any WAF web ACL`,
          evidence: [lb.src],
        });
      }
      for (const d of m.cdnDistributions.filter((d) => ctx.can(d))) {
        if (d.wafAclArn === undefined) {
          ctx.unknown(d, { file: d.src.file, path: `${d.src.path}.WebACLId` }, `WebACLId of CloudFront distribution ${d.id}`);
        } else if (!d.wafAclArn) {
          ctx.report({
            record: d, resource: { kind: "CloudFront distribution", id: d.id, name: d.aliases[0] || d.domainName },
            what: `CloudFront distribution ${d.aliases[0] || d.id} has an empty WebACLId`,
            evidence: [{ file: d.src.file, path: `${d.src.path}.WebACLId` }],
          });
        }
      }
    },
  },

  open_admin_ports: {
    needs: { region: ["SecurityGroups"] },
    action: "Remove the rule and use session-based access instead of an open admin port.",
    run(m, ctx) {
      const admin = ctx.config.admin_ports;
      const rules = worldIngress(m, ctx).filter((r) => coveredPorts(r, admin).length);
      reportGroups(m, ctx, rules, (sg, rs) =>
        `Security group ${sg.groupName} allows admin port${rs.length > 1 ? "s" : ""} ${rs.map((r) => `${portText(r)} from ${r.source.value}`).join(", ")}`);
    },
  },

  open_to_world_non_web: {
    needs: { region: ["SecurityGroups"] },
    action: "Narrow the source to known networks or security groups; keep 0.0.0.0/0 for ports 80/443 on edge services only.",
    run(m, ctx) {
      const { admin_ports: admin, database_ports: db } = ctx.config;
      const rules = worldIngress(m, ctx).filter((r) =>
        !coveredPorts(r, admin).length && (r.protocol === "all" || coveredPorts(r, db).length));
      reportGroups(m, ctx, rules, (sg, rs) =>
        `Security group ${sg.groupName} allows ${rs.map((r) => `${portText(r)} from ${r.source.value}`).join(", ")}`);
    },
  },

  missing_private_endpoints: {
    needs: { region: ["NetworkInterfaces", "VpcEndpoints"] },
    action: "Add an S3 gateway endpoint (and interface endpoints for registry, key and logging traffic).",
    run(m, ctx) {
      for (const n of m.networks.filter((n) => ctx.can(n))) {
        const wl = m.interfaces.filter((e) => e.networkId === n.id && e.role === "workload");
        if (!wl.length) continue;
        const s3 = m.endpoints.some((e) => e.networkId === n.id && e.type === "gateway" && e.serviceShort === "s3");
        if (s3) continue;
        ctx.report({
          record: n, resource: { kind: "VPC", id: n.id, name: networkLabel(n) },
          what: `VPC ${networkLabel(n)} has ${wl.length} workload interface${wl.length > 1 ? "s" : ""} and no S3 gateway endpoint`,
          evidence: [n.src],
        });
      }
    },
  },

  nat_not_per_az: {
    needs: { region: ["NatGateways", "Subnets"] },
    action: "Add a NAT gateway in each zone that hosts workloads, or centralize egress.",
    run(m, ctx) {
      for (const n of m.networks.filter((n) => ctx.can(n))) {
        const nats = m.gateways.filter((g) => g.kind === "nat" && g.networkIds.includes(n.id) && g.state !== "deleted");
        if (!nats.length) continue;
        const natAzs = new Set(nats.map((g) => g.az).filter(Boolean));
        if (natAzs.size >= n.azs.length) continue;
        ctx.report({
          record: n, resource: { kind: "VPC", id: n.id, name: networkLabel(n) },
          what: `VPC ${networkLabel(n)} has NAT gateways in ${natAzs.size} of its ${n.azs.length} availability zones (${[...natAzs].join(", ") || "none"} of ${n.azs.join(", ")})`,
          evidence: [n.src, ...nats.map((g) => g.src)],
        });
      }
    },
  },

  flow_logs_disabled: {
    needs: { region: ["FlowLogs"] },
    action: "Enable flow logs on the VPC, delivered to the central log account.",
    run(m, ctx) {
      for (const n of m.networks.filter((n) => ctx.can(n))) {
        if (m.flowLogs.some((f) => f.resourceId === n.id && f.active)) continue;
        ctx.report({
          record: n, resource: { kind: "VPC", id: n.id, name: networkLabel(n) },
          what: `VPC ${networkLabel(n)} has no active flow log`, evidence: [n.src],
        });
      }
    },
  },

  peering_present: {
    needs: { region: ["VpcPeeringConnections"] },
    action: "Confirm an approved design record exists, or move the connection onto the transit hub.",
    run(m, ctx) {
      const side = (s) => {
        const n = m.networks.find((x) => x.id === s.networkId);
        const a = m.accounts.find((x) => x.id === s.accountId);
        return `${n ? networkLabel(n) : s.networkId} (${a ? a.name : s.accountId}, ${s.region})`;
      };
      for (const p of m.peerings.filter((p) => p.active)) {
        const accountIds = [p.requester.accountId, p.accepter.accountId].filter((id) => m.accounts.some((a) => a.id === id));
        ctx.report({
          record: p, accountIds, region: p.requester.region,
          networkIds: [p.requester.networkId, p.accepter.networkId].filter(Boolean),
          resource: { kind: "VPC peering", id: p.id, name: p.id },
          what: `Active VPC peering ${p.id} between ${side(p.requester)} and ${side(p.accepter)}`,
          evidence: p.seenIn,
        });
      }
    },
  },

  unapproved_region: {
    needs: {},
    action: "Move or remove the resources, and apply the region guardrail policy.",
    run(m, ctx) {
      for (const a of m.accounts) {
        const approved = ctx.config.approved_regions?.[a.cloud] || [];
        for (const r of a.regions.filter((r) => !approved.includes(r))) {
          ctx.report({
            record: a, accountIds: [a.id], region: r, resource: { kind: "region", id: `${a.id}:${r}`, name: r },
            what: `Resources exist in ${r} (approved: ${approved.join(", ")})`,
            evidence: [{ file: a.file, path: `$.Regions["${r}"]` }],
          });
        }
      }
    },
  },

  plain_http_listener: {
    needs: { region: ["LoadBalancers", "Listeners"] },
    action: "Change the port 80 listener to redirect to HTTPS.",
    run(m, ctx) {
      for (const l of m.listeners.filter((l) => l.protocol === "HTTP" && ctx.can(l))) {
        const lb = m.loadBalancers.find((x) => x.id === l.loadBalancerId);
        if (!lb || !lb.internetFacing || l.redirectsToHttps) continue;
        ctx.report({
          record: l, networkIds: lb.networkId ? [lb.networkId] : [],
          resource: { kind: "listener", id: l.id, name: `${lb.name}:${l.port}` },
          what: `Internet-facing load balancer ${lb.name} serves port ${l.port} over plain HTTP (default action: ${l.defaultActions.join(", ") || "none"})`,
          evidence: [l.src],
        });
      }
    },
  },

  single_az_network: {
    needs: { region: ["Vpcs", "Subnets"] },
    action: "Extend the network and its workloads into a second availability zone.",
    run(m, ctx) {
      const min = ctx.config.min_azs_for_prod;
      for (const n of m.networks.filter((n) => n.tags.Environment === "prod" && ctx.can(n))) {
        if (n.azs.length >= min) continue;
        ctx.report({
          record: n, resource: { kind: "VPC", id: n.id, name: networkLabel(n) },
          what: `Production VPC ${networkLabel(n)} spans ${n.azs.length} availability zone${n.azs.length === 1 ? "" : "s"} (minimum ${min})`,
          evidence: [n.src],
        });
      }
    },
  },

  missing_required_tags: {
    needs: { region: ["Vpcs"] },
    action: "Add the missing tags through the pipeline tag policy.",
    run(m, ctx) {
      for (const n of m.networks.filter((n) => !n.isDefault && ctx.can(n))) {
        const missing = ctx.config.required_tags.filter((t) => !n.tags[t]);
        if (!missing.length) continue;
        ctx.report({
          record: n, resource: { kind: "VPC", id: n.id, name: networkLabel(n) },
          what: `VPC ${networkLabel(n)} is missing required tag${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`,
          evidence: [{ file: n.src.file, path: `${n.src.path}.Tags` }],
        });
      }
    },
  },
};
