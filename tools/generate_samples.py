#!/usr/bin/env python3
"""
Generate SYNTHETIC cloud inventory exports for the fictional Kestrel Ridge Financial
portfolio project. Nothing here comes from a real environment.

AWS files mirror the shape of AWS CLI describe-* output, merged into one file per account.
Azure and GCP files mirror `az network ... list` and `gcloud compute ... list` output.

Usage:  python3 tools/generate_samples.py [output_dir]
Default output_dir: samples/ (next to tools/)

The generator is deterministic (fixed seed), so re-running gives identical files.
It also writes samples/EXPECTED_FINDINGS.md, an answer key of every problem it planted.
"""
import ipaddress
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "samples"
rng = random.Random(20261028)
GENERATED = "2026-10-28T12:00:00Z"

REGION_KEYS = [
    "Vpcs", "Subnets", "RouteTables", "InternetGateways", "NatGateways",
    "TransitGateways", "TransitGatewayAttachments", "VpcEndpoints",
    "NetworkInterfaces", "SecurityGroups", "VpcPeeringConnections", "FlowLogs",
    "LoadBalancers", "Listeners", "WebAcls", "WebAclResources",
]

# Check id -> standard id in ai-skills/Cloud_Standards.yaml
CHECK_TO_STANDARD = {
    "account_role_tag_present": "NET-01",
    "default_network_present": "NET-02",
    "cidr_overlap": "NET-03",
    "workload_in_public_subnet": "NET-04",
    "public_endpoint_without_waf": "NET-05",
    "open_admin_ports": "NET-06",
    "open_to_world_non_web": "NET-07",
    "missing_private_endpoints": "NET-08",
    "nat_not_per_az": "NET-09",
    "flow_logs_disabled": "NET-10",
    "peering_present": "NET-11",
    "unapproved_region": "SEC-04",
    "plain_http_listener": "DAT-01",
    "single_az_network": "RES-01",
    "missing_required_tags": "OPS-01",
}
PLANTED = []  # (file, check, standard, detail)


def plant(file, check, detail):
    PLANTED.append((file, check, CHECK_TO_STANDARD[check], detail))


def hx(n):
    return "".join(rng.choice("0123456789abcdef") for _ in range(n))


def rid(prefix, n=17):
    return f"{prefix}-{hx(n)}"


def uuid():
    return "-".join([hx(8), hx(4), hx(4), hx(4), hx(12)])


def tag_list(d):
    return [{"Key": k, "Value": v} for k, v in d.items()]


def pub_ip():
    # Documentation-only address ranges (RFC 5737); not real hosts.
    return rng.choice(["203.0.113", "198.51.100"]) + f".{rng.randint(2, 250)}"


def az_short(region):
    p = region.split("-")
    return f"{p[0]}{p[1][0]}{p[2]}"


_used = {}


def next_ip(subnet):
    n = _used.get(subnet["SubnetId"], 3) + 1
    _used[subnet["SubnetId"]] = n
    return n


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2) + "\n")


class Account:
    def __init__(self, company, slug, name, acct_id, role, env, app, owner, cost_center,
                 drop_account_role=False):
        self.company, self.slug, self.name, self.id = company, slug, name, acct_id
        self.file = f"{name}.json"
        self.base_tags = {"Owner": owner, "Environment": env,
                          "CostCenter": cost_center, "Application": app}
        self.account_tags = {"AccountRole": role, "Environment": env, "Owner": owner}
        if drop_account_role:
            self.account_tags.pop("AccountRole")
        self.regions = {}
        self.glob = {"CloudFrontDistributions": [], "WebAclsGlobal": []}
        self.logbucket = f"arn:aws:s3:::{slug}-central-flow-logs"

    def region(self, r):
        return self.regions.setdefault(r, {k: [] for k in REGION_KEYS})

    def export(self):
        return {
            "_export": {
                "schema": "aws-account-inventory/1.0",
                "generated": GENERATED,
                "synthetic": True,
                "source": ("SYNTHETIC SAMPLE: fictional company, not a real environment. "
                           "Shapes mirror AWS CLI describe-* output merged per account."),
            },
            "Account": {"AccountId": self.id, "AccountName": self.name,
                        "Company": self.company, "Tags": self.account_tags},
            "Regions": dict(sorted(self.regions.items())),
            "Global": self.glob,
        }


def make_eni(a, vpc_id, subnet, itype, desc, groups, public_ip=None):
    d = {
        "NetworkInterfaceId": rid("eni"),
        "SubnetId": subnet["SubnetId"],
        "VpcId": vpc_id,
        "AvailabilityZone": subnet["AvailabilityZone"],
        "OwnerId": a.id,
        "InterfaceType": itype,
        "Description": desc,
        "PrivateIpAddress": str(ipaddress.ip_network(subnet["CidrBlock"])[next_ip(subnet)]),
        "Status": "in-use",
        "SourceDestCheck": True,
        "Groups": groups,
    }
    if public_ip:
        d["Association"] = {"PublicIp": public_ip, "IpOwnerId": "amazon"}
    return d


def add_vpc(a, region, name, cidr, n_az, tiers, *, igw=False, nat_azs=(), endpoints=(),
            flow_logs=True, drop_tags=(), is_default=False, tgw=None, workloads=0,
            public_workloads=0, public_workload_sg="app", sgs=()):
    """Add one VPC and everything inside it to account `a`. Returns a dict for later use."""
    R = a.region(region)
    azs = [f"{region}{c}" for c in "abc"[:n_az]]
    net = ipaddress.ip_network(cidr)
    if is_default:
        new_prefix = 20
    else:
        new_prefix = 24 if net.prefixlen <= 22 else min(net.prefixlen + 2, 28)
    blocks = list(net.subnets(new_prefix=new_prefix))
    vpc_id = rid("vpc")
    tags = {k: v for k, v in a.base_tags.items() if k not in drop_tags}
    vpc_tags = {} if is_default else {**tags, "Name": name}
    R["Vpcs"].append({
        "VpcId": vpc_id, "CidrBlock": cidr, "State": "available", "IsDefault": is_default,
        "OwnerId": a.id, "InstanceTenancy": "default", "DhcpOptionsId": rid("dopt", 8),
        "Tags": tag_list(vpc_tags),
    })

    # Subnets
    subnets, bi = {}, 0
    for tier, public in tiers:
        for i, az in enumerate(azs):
            blk = blocks[bi]
            bi += 1
            sub = {
                "SubnetId": rid("subnet"), "VpcId": vpc_id, "CidrBlock": str(blk),
                "AvailabilityZone": az, "AvailabilityZoneId": f"{az_short(region)}-az{i + 1}",
                "State": "available", "MapPublicIpOnLaunch": public,
                "AvailableIpAddressCount": blk.num_addresses - 5 - rng.randint(2, 40),
                "OwnerId": a.id,
                "Tags": [] if is_default else tag_list({"Name": f"{name}-{tier}-{az[-1]}", "Tier": tier}),
            }
            subnets[(tier, i)] = sub
            R["Subnets"].append(sub)
    pub_tiers = [t for t, p in tiers if p]
    priv_tiers = [t for t, p in tiers if not p]
    pubs = [subnets[(pub_tiers[0], i)] for i in range(n_az)] if pub_tiers else []
    apps = [subnets[(priv_tiers[0], i)] for i in range(n_az)] if priv_tiers else []

    # Security groups (two passes so groups can reference each other by name)
    specs = [{"name": "default", "desc": "default VPC security group",
              "ingress": [("-1", None, None, "sg:default")]}] + list(sgs)
    sg_ids = {sp["name"]: rid("sg") for sp in specs}

    def grp(n):
        return {"GroupId": sg_ids[n], "GroupName": n}

    for sp in specs:
        perms = []
        for proto, lo, hi, src in sp["ingress"]:
            p = {"IpProtocol": proto, "IpRanges": [], "Ipv6Ranges": [],
                 "PrefixListIds": [], "UserIdGroupPairs": []}
            if lo is not None:
                p["FromPort"], p["ToPort"] = lo, hi
            if src.startswith("sg:"):
                p["UserIdGroupPairs"].append({"GroupId": sg_ids[src[3:]], "UserId": a.id})
            else:
                p["IpRanges"].append({"CidrIp": src})
            perms.append(p)
        R["SecurityGroups"].append({
            "GroupId": sg_ids[sp["name"]], "GroupName": sp["name"], "Description": sp["desc"],
            "VpcId": vpc_id, "OwnerId": a.id, "IpPermissions": perms,
            "IpPermissionsEgress": [{"IpProtocol": "-1", "IpRanges": [{"CidrIp": "0.0.0.0/0"}],
                                     "Ipv6Ranges": [], "PrefixListIds": [], "UserIdGroupPairs": []}],
            "Tags": tag_list({} if sp["name"] == "default" else {**tags, "Name": f"{name}-{sp['name']}"}),
        })

    # Internet gateway
    igw_id = None
    if igw or is_default:
        igw_id = rid("igw")
        R["InternetGateways"].append({
            "InternetGatewayId": igw_id, "OwnerId": a.id,
            "Attachments": [{"VpcId": vpc_id, "State": "available"}],
            "Tags": tag_list({} if is_default else {**tags, "Name": f"{name}-igw"}),
        })

    # NAT gateways (each has its own network interface)
    nat_by_az = {}
    for i in nat_azs:
        e = make_eni(a, vpc_id, pubs[i], "nat_gateway", "", [], public_ip=pub_ip())
        nat_id = rid("nat")
        e["Description"] = f"Interface for NAT Gateway {nat_id}"
        R["NetworkInterfaces"].append(e)
        R["NatGateways"].append({
            "NatGatewayId": nat_id, "VpcId": vpc_id, "SubnetId": pubs[i]["SubnetId"],
            "State": "available", "ConnectivityType": "public",
            "CreateTime": "2025-03-14T15:02:11+00:00",
            "NatGatewayAddresses": [{
                "AllocationId": rid("eipalloc"), "NetworkInterfaceId": e["NetworkInterfaceId"],
                "PrivateIp": e["PrivateIpAddress"], "PublicIp": e["Association"]["PublicIp"]}],
            "Tags": tag_list({**tags, "Name": f"{name}-nat-{azs[i][-1]}"}),
        })
        nat_by_az[i] = nat_id

    # Route tables
    local = {"DestinationCidrBlock": cidr, "GatewayId": "local", "State": "active"}

    def new_rt(label, routes, assoc_subnets, main=False):
        rt_id = rid("rtb")
        assoc = [{"RouteTableAssociationId": rid("rtbassoc"), "RouteTableId": rt_id,
                  "SubnetId": s["SubnetId"], "AssociationState": {"State": "associated"}}
                 for s in assoc_subnets]
        if main:
            assoc.append({"RouteTableAssociationId": rid("rtbassoc"), "RouteTableId": rt_id,
                          "Main": True, "AssociationState": {"State": "associated"}})
        R["RouteTables"].append({
            "RouteTableId": rt_id, "VpcId": vpc_id, "OwnerId": a.id, "Routes": routes,
            "Associations": assoc,
            "Tags": tag_list({} if main else {**tags, "Name": f"{name}-rt-{label}"}),
        })
        return rt_id

    private_rts = []
    if is_default:
        new_rt("main", [local, {"DestinationCidrBlock": "0.0.0.0/0", "GatewayId": igw_id,
                                "State": "active"}], [], main=True)
    else:
        if pubs and igw_id:
            new_rt("public", [local, {"DestinationCidrBlock": "0.0.0.0/0", "GatewayId": igw_id,
                                      "State": "active"}], pubs)
        tgw_route = ({"DestinationCidrBlock": "10.0.0.0/8", "TransitGatewayId": tgw[0],
                      "State": "active"} if tgw else None)
        for ti, tier in enumerate(priv_tiers):
            if ti == 0:
                for i in range(n_az):
                    routes = [local]
                    if nat_by_az:
                        routes.append({"DestinationCidrBlock": "0.0.0.0/0", "State": "active",
                                       "NatGatewayId": nat_by_az.get(i, next(iter(nat_by_az.values())))})
                    elif tgw:
                        routes.append({"DestinationCidrBlock": "0.0.0.0/0", "State": "active",
                                       "TransitGatewayId": tgw[0]})
                    if tgw_route:
                        routes.append(tgw_route)
                    private_rts.append(new_rt(f"{tier}-{azs[i][-1]}", routes, [subnets[(tier, i)]]))
            else:
                routes = [local] + ([tgw_route] if tgw_route else [])
                private_rts.append(new_rt(tier, routes, [subnets[(tier, i)] for i in range(n_az)]))

    # VPC endpoints
    for svc, typ in endpoints:
        ep_id = rid("vpce")
        ep = {
            "VpcEndpointId": ep_id, "VpcEndpointType": typ, "VpcId": vpc_id,
            "ServiceName": f"com.amazonaws.{region}.{svc}", "State": "available",
            "OwnerId": a.id, "PrivateDnsEnabled": typ == "Interface",
            "RouteTableIds": list(private_rts) if typ == "Gateway" else [],
            "SubnetIds": [s["SubnetId"] for s in apps] if typ == "Interface" else [],
            "Groups": [grp("default")] if typ == "Interface" else [],
            "NetworkInterfaceIds": [],
            "Tags": tag_list({**tags, "Name": f"{name}-{svc.replace('.', '-')}"}),
        }
        if typ == "Interface":
            for s in apps:
                e = make_eni(a, vpc_id, s, "vpc_endpoint", f"VPC Endpoint Interface {ep_id}", [grp("default")])
                R["NetworkInterfaces"].append(e)
                ep["NetworkInterfaceIds"].append(e["NetworkInterfaceId"])
        R["VpcEndpoints"].append(ep)

    # Workload interfaces
    wl_grp = grp("app") if "app" in sg_ids else grp("default")
    for k in range(workloads):
        R["NetworkInterfaces"].append(make_eni(
            a, vpc_id, apps[k % n_az], "interface", f"{name} workload {k + 1}", [wl_grp]))
    for k in range(public_workloads):
        R["NetworkInterfaces"].append(make_eni(
            a, vpc_id, pubs[k % n_az], "interface", f"{name} public workload {k + 1}",
            [grp(public_workload_sg)], public_ip=pub_ip()))

    # Transit gateway attachment
    if tgw:
        tgw_id, owner = tgw
        att = {
            "TransitGatewayAttachmentId": rid("tgw-attach"), "TransitGatewayId": tgw_id,
            "TransitGatewayOwnerId": owner.id, "ResourceOwnerId": a.id, "ResourceType": "vpc",
            "ResourceId": vpc_id, "State": "available",
            "Association": {"TransitGatewayRouteTableId": "tgw-rtb-0a1b2c3d4e5f60718", "State": "associated"},
            "SubnetIds": [s["SubnetId"] for s in apps],
            "Tags": tag_list({**tags, "Name": f"{name}-tgw-attach"}),
        }
        R["TransitGatewayAttachments"].append(att)
        if owner is not a:
            owner.region(region)["TransitGatewayAttachments"].append(att)

    # Flow logs
    if flow_logs:
        R["FlowLogs"].append({
            "FlowLogId": rid("fl"), "ResourceId": vpc_id, "TrafficType": "ALL",
            "LogDestinationType": "s3", "LogDestination": a.logbucket,
            "FlowLogStatus": "ACTIVE", "CreationTime": "2025-03-14T15:30:00+00:00",
        })

    return {"vpc_id": vpc_id, "cidr": cidr, "region": region, "azs": azs,
            "pubs": pubs, "apps": apps, "sg_ids": sg_ids}


def add_lb(a, region, vpc, name, scheme, listeners, waf, sg):
    R = a.region(region)
    subs = vpc["pubs"] if scheme == "internet-facing" else vpc["apps"]
    lb_hex = hx(16)
    arn = f"arn:aws:elasticloadbalancing:{region}:{a.id}:loadbalancer/app/{name}/{lb_hex}"
    sg_id = vpc["sg_ids"][sg]
    lb = {
        "LoadBalancerArn": arn, "DNSName": f"{name}-{hx(9)}.{region}.elb.amazonaws.com",
        "CanonicalHostedZoneId": "Z35SXDOTRQ7X7K", "CreatedTime": "2025-02-20T14:31:09+00:00",
        "LoadBalancerName": name, "Scheme": scheme, "VpcId": vpc["vpc_id"],
        "State": {"Code": "active"}, "Type": "application",
        "AvailabilityZones": [{"ZoneName": s["AvailabilityZone"], "SubnetId": s["SubnetId"]} for s in subs],
        "SecurityGroups": [sg_id], "IpAddressType": "ipv4",
    }
    R["LoadBalancers"].append(lb)
    for s in subs:
        R["NetworkInterfaces"].append(make_eni(
            a, vpc["vpc_id"], s, "interface", f"ELB app/{name}/{lb_hex}",
            [{"GroupId": sg_id, "GroupName": sg}],
            public_ip=pub_ip() if scheme == "internet-facing" else None))
    for port, proto, action in listeners:
        da = {"Type": action}
        if action == "redirect":
            da["RedirectConfig"] = {"Protocol": "HTTPS", "Port": "443", "StatusCode": "HTTP_301"}
        lst = {"ListenerArn": arn.replace(":loadbalancer/", ":listener/") + "/" + hx(16),
               "LoadBalancerArn": arn, "Port": port, "Protocol": proto, "DefaultActions": [da]}
        if proto == "HTTPS":
            lst["SslPolicy"] = "ELBSecurityPolicy-TLS13-1-2-2021-06"
        R["Listeners"].append(lst)
    if waf:
        acl = next(iter(R["WebAcls"]), None)
        if acl is None:
            acl = {"Name": "baseline-regional-waf", "Id": uuid(), "Scope": "REGIONAL"}
            acl["ARN"] = f"arn:aws:wafv2:{region}:{a.id}:regional/webacl/baseline-regional-waf/{acl['Id']}"
            R["WebAcls"].append(acl)
            R["WebAclResources"].append({"WebAclArn": acl["ARN"], "ResourceArns": []})
        entry = next(e for e in R["WebAclResources"] if e["WebAclArn"] == acl["ARN"])
        entry["ResourceArns"].append(arn)
    return lb


def add_cloudfront(a, alias, origin_dns, waf):
    acl_arn = ""
    if waf:
        acl_id = uuid()
        acl_arn = f"arn:aws:wafv2:us-east-1:{a.id}:global/webacl/baseline-edge-waf/{acl_id}"
        a.glob["WebAclsGlobal"].append(
            {"Name": "baseline-edge-waf", "Id": acl_id, "ARN": acl_arn, "Scope": "CLOUDFRONT"})
    dist_id = "E" + hx(13).upper()
    a.glob["CloudFrontDistributions"].append({
        "Id": dist_id, "ARN": f"arn:aws:cloudfront::{a.id}:distribution/{dist_id}",
        "DomainName": f"d{hx(13)}.cloudfront.net",
        "Aliases": {"Quantity": 1, "Items": [alias]}, "Enabled": True, "WebACLId": acl_arn,
        "Origins": {"Quantity": 1, "Items": [{"Id": "edge-alb", "DomainName": origin_dns}]},
    })


def add_peering(a1, v1, a2, v2):
    rec = {
        "VpcPeeringConnectionId": rid("pcx"),
        "Status": {"Code": "active", "Message": "Active"},
        "RequesterVpcInfo": {"VpcId": v1["vpc_id"], "OwnerId": a1.id, "CidrBlock": v1["cidr"], "Region": v1["region"]},
        "AccepterVpcInfo": {"VpcId": v2["vpc_id"], "OwnerId": a2.id, "CidrBlock": v2["cidr"], "Region": v2["region"]},
        "Tags": [],
    }
    a1.region(v1["region"])["VpcPeeringConnections"].append(rec)
    a2.region(v2["region"])["VpcPeeringConnections"].append(rec)


# ---------------------------------------------------------------------------
# AWS: Tidewater Payments (fictional). Mostly well run, with a few planted problems.
# ---------------------------------------------------------------------------
TW = "Tidewater Payments"
tw_net = Account(TW, "tidewater", "tidewater-shared-network", "710420000001", "shared-network",
                 "shared", "edge-network", "network-engineering", "CC-1001")
tw_prod = Account(TW, "tidewater", "tidewater-prod-app", "710420000002", "prod",
                  "prod", "payments-api", "payments-team", "CC-2040")
tw_non = Account(TW, "tidewater", "tidewater-nonprod-app", "710420000003", "nonprod",
                 "nonprod", "payments-api", "payments-team", "CC-2041")
tw_data = Account(TW, "tidewater", "tidewater-data-platform", "710420000004", "data",
                  "prod", "data-platform", "data-team", "CC-3010")
tw_sec = Account(TW, "tidewater", "tidewater-security-logging", "710420000005", "security",
                 "shared", "security-logging", "security-team", "CC-4001")

tgw_id = rid("tgw")
tw_net.region("us-east-1")["TransitGateways"].append({
    "TransitGatewayId": tgw_id, "TransitGatewayArn": f"arn:aws:ec2:us-east-1:{tw_net.id}:transit-gateway/{tgw_id}",
    "State": "available", "OwnerId": tw_net.id, "Description": "Shared transit hub",
    "Options": {"AmazonSideAsn": 64512, "DefaultRouteTableAssociation": "disable",
                "DefaultRouteTablePropagation": "disable"},
    "Tags": tag_list({**tw_net.base_tags, "Name": "tw-transit-hub"}),
})

web_sg = {"name": "alb-public", "desc": "Public ALB: HTTP and HTTPS from the internet",
          "ingress": [("tcp", 443, 443, "0.0.0.0/0"), ("tcp", 80, 80, "0.0.0.0/0")]}
app_sgs = [
    {"name": "alb-internal", "desc": "Internal ALB", "ingress": [("tcp", 443, 443, "10.0.0.0/8")]},
    {"name": "app", "desc": "Application tier", "ingress": [("tcp", 8443, 8443, "sg:alb-internal")]},
    {"name": "db", "desc": "Database tier", "ingress": [("tcp", 5432, 5432, "sg:app")]},
]
std_endpoints = [("s3", "Gateway"), ("dynamodb", "Gateway"), ("ecr.api", "Interface"),
                 ("ecr.dkr", "Interface"), ("logs", "Interface")]

# Shared network: edge VPC (public entry + egress hub) and a DR edge in a second region
edge = add_vpc(tw_net, "us-east-1", "tw-edge", "10.20.0.0/20", 3,
               [("public", True), ("attach", False)], igw=True, nat_azs=(0, 1, 2),
               tgw=(tgw_id, tw_net), sgs=[web_sg])
edge_lb = add_lb(tw_net, "us-east-1", edge, "tw-edge-alb", "internet-facing",
                 [(443, "HTTPS", "forward"), (80, "HTTP", "redirect")], waf=True, sg="alb-public")
add_cloudfront(tw_net, "pay.tidewater.example", edge_lb["DNSName"], waf=True)
edge_dr = add_vpc(tw_net, "us-west-2", "tw-edge-dr", "10.21.0.0/20", 2,
                  [("public", True), ("attach", False)], igw=True, nat_azs=(0, 1), sgs=[web_sg])
add_lb(tw_net, "us-west-2", edge_dr, "tw-edge-dr-alb", "internet-facing",
       [(443, "HTTPS", "forward"), (80, "HTTP", "redirect")], waf=True, sg="alb-public")

# Prod: NAT in only one of three zones; a leftover bastion rule open to the internet
add_vpc(tw_prod, "us-east-1", "tw-prod-app", "10.20.16.0/20", 3,
        [("public", True), ("app", False), ("data", False)], igw=True, nat_azs=(0,),
        endpoints=std_endpoints, tgw=(tgw_id, tw_net), workloads=6,
        sgs=app_sgs + [{"name": "legacy-bastion", "desc": "Legacy bastion access",
                        "ingress": [("tcp", 22, 22, "0.0.0.0/0")]}])
plant(tw_prod.file, "nat_not_per_az", "VPC tw-prod-app has a NAT gateway in 1 of its 3 availability zones")
plant(tw_prod.file, "open_admin_ports", "Security group tw-prod-app-legacy-bastion allows SSH (22) from 0.0.0.0/0")
add_vpc(tw_prod, "us-west-2", "tw-prod-app-dr", "10.21.16.0/20", 2,
        [("public", True), ("app", False), ("data", False)], igw=True, nat_azs=(0, 1),
        endpoints=[("s3", "Gateway"), ("logs", "Interface")], workloads=2, sgs=app_sgs,
        drop_tags=("CostCenter",))
plant(tw_prod.file, "missing_required_tags", "VPC tw-prod-app-dr is missing the CostCenter tag")

# Nonprod: overlaps the data platform network; an unused default VPC without flow logs
add_vpc(tw_non, "us-east-1", "tw-nonprod-app", "10.20.32.0/20", 2,
        [("public", True), ("app", False)], igw=True, nat_azs=(0, 1),
        endpoints=[("s3", "Gateway"), ("logs", "Interface")], tgw=(tgw_id, tw_net),
        workloads=4, sgs=app_sgs)
add_vpc(tw_non, "us-west-2", "default", "172.31.0.0/16", 3, [("default", True)],
        is_default=True, flow_logs=False)
plant(tw_non.file, "default_network_present", "Default VPC (172.31.0.0/16) still exists in us-west-2")
plant(tw_non.file, "flow_logs_disabled", "Default VPC in us-west-2 has no flow logs")
plant(tw_non.file, "cidr_overlap", "VPC tw-nonprod-app (10.20.32.0/20) overlaps tw-data-platform in tidewater-data-platform.json")

# Data platform: no flow logs; one network in an unapproved region
add_vpc(tw_data, "us-east-1", "tw-data-platform", "10.20.32.0/20", 3,
        [("app", False), ("data", False)], endpoints=[("s3", "Gateway"), ("glue", "Interface"), ("logs", "Interface")],
        tgw=(tgw_id, tw_net), workloads=5, sgs=app_sgs, flow_logs=False)
plant(tw_data.file, "flow_logs_disabled", "VPC tw-data-platform has no flow logs")
plant(tw_data.file, "cidr_overlap", "VPC tw-data-platform (10.20.32.0/20) overlaps tw-nonprod-app in tidewater-nonprod-app.json")
add_vpc(tw_data, "eu-west-1", "tw-data-eu", "10.22.0.0/20", 2,
        [("app", False), ("data", False)], endpoints=[("s3", "Gateway"), ("logs", "Interface")],
        workloads=2, sgs=app_sgs)
plant(tw_data.file, "unapproved_region", "Resources exist in eu-west-1 (approved: us-east-1, us-west-2)")

# Security and logging: clean
add_vpc(tw_sec, "us-east-1", "tw-seclog", "10.20.64.0/22", 2, [("app", False)],
        endpoints=[("s3", "Gateway"), ("logs", "Interface")], tgw=(tgw_id, tw_net),
        workloads=2, sgs=app_sgs)

# ---------------------------------------------------------------------------
# AWS: Larkspur Lending (fictional). Messier: the kind of estate an acquisition brings.
# ---------------------------------------------------------------------------
LL = "Larkspur Lending"
ll_prod = Account(LL, "larkspur", "larkspur-prod", "880310000001", "prod", "prod",
                  "loan-portal", "web-team", "CC-7001", drop_account_role=True)
ll_leg = Account(LL, "larkspur", "larkspur-legacy", "880310000002", "legacy", "prod",
                 "batch-processing", "ops-team", "CC-7002", drop_account_role=True)
plant(ll_prod.file, "account_role_tag_present", "Account has no AccountRole tag")
plant(ll_leg.file, "account_role_tag_present", "Account has no AccountRole tag")

lp = add_vpc(ll_prod, "us-east-1", "ll-prod-web", "10.50.0.0/16", 2,
             [("public", True), ("app", False)], igw=True, nat_azs=(0,), flow_logs=False,
             drop_tags=("Owner", "CostCenter"), workloads=3, public_workloads=2,
             public_workload_sg="app-open",
             sgs=[web_sg,
                  {"name": "app", "desc": "App tier", "ingress": [("tcp", 8080, 8080, "sg:alb-public")]},
                  {"name": "app-open", "desc": "App servers (temporary, wide open)",
                   "ingress": [("-1", None, None, "0.0.0.0/0")]},
                  {"name": "db-legacy", "desc": "Legacy MySQL",
                   "ingress": [("tcp", 3306, 3306, "0.0.0.0/0")]}])
add_lb(ll_prod, "us-east-1", lp, "ll-portal-alb", "internet-facing",
       [(80, "HTTP", "forward"), (443, "HTTPS", "forward")], waf=False, sg="alb-public")
plant(ll_prod.file, "public_endpoint_without_waf", "Public ALB ll-portal-alb has no WAF attached")
plant(ll_prod.file, "plain_http_listener", "ll-portal-alb serves port 80 over plain HTTP (forward, not redirect)")
plant(ll_prod.file, "nat_not_per_az", "VPC ll-prod-web has a NAT gateway in 1 of its 2 availability zones")
plant(ll_prod.file, "flow_logs_disabled", "VPC ll-prod-web has no flow logs")
plant(ll_prod.file, "missing_required_tags", "VPC ll-prod-web is missing Owner and CostCenter tags")
plant(ll_prod.file, "workload_in_public_subnet", "2 workload interfaces in a public subnet have public IP addresses")
plant(ll_prod.file, "open_to_world_non_web", "Security group ll-prod-web-app-open allows all traffic from 0.0.0.0/0")
plant(ll_prod.file, "open_to_world_non_web", "Security group ll-prod-web-db-legacy allows MySQL (3306) from 0.0.0.0/0")
plant(ll_prod.file, "missing_private_endpoints", "VPC ll-prod-web has workloads but no S3 gateway endpoint")

ll_vpc = add_vpc(ll_leg, "us-east-2", "ll-legacy-batch", "10.60.0.0/20", 1, [("app", False)],
                 flow_logs=False, drop_tags=("Application",), workloads=2,
                 sgs=[{"name": "app", "desc": "Batch servers", "ingress": [("tcp", 9000, 9000, "10.50.0.0/16")]},
                      {"name": "ssh-any", "desc": "SSH from anywhere", "ingress": [("tcp", 22, 22, "0.0.0.0/0")]}])
add_peering(ll_prod, lp, ll_leg, ll_vpc)
plant(ll_leg.file, "unapproved_region", "Resources exist in us-east-2 (approved: us-east-1, us-west-2)")
plant(ll_leg.file, "single_az_network", "Production VPC ll-legacy-batch spans 1 availability zone")
plant(ll_leg.file, "open_admin_ports", "Security group ll-legacy-batch-ssh-any allows SSH (22) from 0.0.0.0/0")
plant(ll_leg.file, "flow_logs_disabled", "VPC ll-legacy-batch has no flow logs")
plant(ll_leg.file, "missing_required_tags", "VPC ll-legacy-batch is missing the Application tag")
plant(ll_leg.file, "missing_private_endpoints", "VPC ll-legacy-batch has workloads but no S3 gateway endpoint")
plant(ll_leg.file, "peering_present", "Peering with larkspur-prod (us-east-1 to us-east-2)")
plant(ll_prod.file, "peering_present", "Peering with larkspur-legacy (us-east-1 to us-east-2)")

for acct in (tw_net, tw_prod, tw_non, tw_data, tw_sec):
    write_json(OUT / "aws" / "tidewater-payments" / acct.file, acct.export())
for acct in (ll_prod, ll_leg):
    write_json(OUT / "aws" / "larkspur-lending" / acct.file, acct.export())


def aws_counts(acct):
    """Per-account counts, same columns as the dashboard parser's count summary (build step 1)."""
    regs = acct.export()["Regions"]
    allr = lambda k: [x for R in regs.values() for x in R[k]]
    subnets, rts = allr("Subnets"), allr("RouteTables")
    explicit = {a["SubnetId"]: rt for rt in rts for a in rt["Associations"] if "SubnetId" in a}
    main = {rt["VpcId"]: rt for rt in rts if any(a.get("Main") for a in rt["Associations"])}
    to_igw = lambda rt: any(r["DestinationCidrBlock"] == "0.0.0.0/0" and r.get("GatewayId", "").startswith("igw-")
                            for r in rt["Routes"])
    enis = allr("NetworkInterfaces")
    lbs = allr("LoadBalancers")
    rules = [r for g in allr("SecurityGroups") for p in g["IpPermissions"] for r in p["IpRanges"]]
    return {
        "regions": len(regs),
        "azs": len({s["AvailabilityZone"] for s in subnets}),
        "vpcs": len(allr("Vpcs")),
        "defaultVpcs": sum(v["IsDefault"] for v in allr("Vpcs")),
        "subnets": len(subnets),
        "publicSubnets": sum(to_igw(explicit.get(s["SubnetId"]) or main.get(s["VpcId"]) or {"Routes": []})
                             for s in subnets),
        "internetGateways": len(allr("InternetGateways")),
        "natGateways": len(allr("NatGateways")),
        "transitGateways": len(allr("TransitGateways")),
        "transitAttachments": sum(t["ResourceOwnerId"] == acct.id for t in allr("TransitGatewayAttachments")),
        "peerings": len(allr("VpcPeeringConnections")),
        "endpoints": len(allr("VpcEndpoints")),
        "interfaces": len(enis),
        "workloadInterfaces": sum(e["InterfaceType"] == "interface" and not e["Description"].startswith("ELB ")
                                  for e in enis),
        "securityGroups": len(allr("SecurityGroups")),
        "worldIngressRules": sum(r["CidrIp"] == "0.0.0.0/0" for r in rules),
        "loadBalancers": len(lbs),
        "publicLoadBalancers": sum(lb["Scheme"] == "internet-facing" for lb in lbs),
        "listeners": len(allr("Listeners")),
        "cdnDistributions": len(acct.glob["CloudFrontDistributions"]),
        "activeFlowLogs": sum(f["FlowLogStatus"] == "ACTIVE" for f in allr("FlowLogs")),
    }


def print_aws_counts(company, accts):
    rows = [(a.name, aws_counts(a)) for a in accts]
    cols = list(rows[0][1])
    table = [["account", *cols]] + [[n, *(str(c[k]) for k in cols)] for n, c in rows]
    widths = [max(len(r[i]) for r in table) for i in range(len(table[0]))]
    print(f"== {company} ({len(accts)} accounts)")
    for r in table:
        print("  ".join(v.ljust(w) for v, w in zip(r, widths)).rstrip())
    print()


# ---------------------------------------------------------------------------
# Azure: Brightwater Insurance (fictional), one subscription
# ---------------------------------------------------------------------------
def build_azure():
    fname = "brightwater-prod-subscription.json"
    sub_id = uuid()
    rg = "rg-brightwater-prod-network"
    tags = {"Owner": "claims-platform", "Environment": "prod",
            "CostCenter": "CC-5100", "Application": "claims-portal"}

    def az_id(kind, name):
        return f"/subscriptions/{sub_id}/resourceGroups/{rg}/providers/Microsoft.Network/{kind}/{name}"

    def rule(name, prio, src, port):
        return {"name": name, "priority": prio, "direction": "Inbound", "access": "Allow",
                "protocol": "Tcp", "sourceAddressPrefix": src, "sourcePortRange": "*",
                "destinationAddressPrefix": "*", "destinationPortRange": port}

    nsgs = [
        {"name": "nsg-web", "id": az_id("networkSecurityGroups", "nsg-web"), "location": "eastus",
         "tags": tags, "securityRules": [rule("allow-https-in", 100, "Internet", "443")]},
        {"name": "nsg-app", "id": az_id("networkSecurityGroups", "nsg-app"), "location": "eastus",
         "tags": tags, "securityRules": [rule("allow-from-web", 100, "10.30.0.0/24", "8443")]},
        {"name": "nsg-mgmt", "id": az_id("networkSecurityGroups", "nsg-mgmt"), "location": "eastus",
         "tags": tags, "securityRules": [rule("allow-rdp-any", 100, "*", "3389")]},
    ]
    plant(fname, "open_admin_ports", "NSG nsg-mgmt allows RDP (3389) from any source")

    def snet(vnet, name, prefix, nsg=None, nat=None):
        d = {"name": name, "id": az_id("virtualNetworks", vnet) + f"/subnets/{name}", "addressPrefix": prefix}
        if nsg:
            d["networkSecurityGroup"] = {"id": az_id("networkSecurityGroups", nsg)}
        if nat:
            d["natGateway"] = {"id": az_id("natGateways", nat)}
        return d

    vnets = [
        {"name": "vnet-prod-eus", "id": az_id("virtualNetworks", "vnet-prod-eus"), "location": "eastus",
         "tags": tags, "addressSpace": {"addressPrefixes": ["10.30.0.0/20"]},
         "subnets": [snet("vnet-prod-eus", "snet-web", "10.30.0.0/24", "nsg-web"),
                     snet("vnet-prod-eus", "snet-app", "10.30.1.0/24", "nsg-app", "nat-prod-eus"),
                     snet("vnet-prod-eus", "snet-mgmt", "10.30.2.0/24", "nsg-mgmt"),
                     snet("vnet-prod-eus", "snet-pe", "10.30.3.0/24")],
         "virtualNetworkPeerings": []},
        {"name": "vnet-dr-neu", "id": az_id("virtualNetworks", "vnet-dr-neu"), "location": "northeurope",
         "tags": tags, "addressSpace": {"addressPrefixes": ["10.31.0.0/20"]},
         "subnets": [snet("vnet-dr-neu", "snet-app", "10.31.1.0/24")],
         "virtualNetworkPeerings": []},
    ]
    plant(fname, "unapproved_region", "VNet vnet-dr-neu is in northeurope (approved: eastus, eastus2, westus2)")
    plant(fname, "flow_logs_disabled", "VNet vnet-dr-neu has no flow log")

    def agw(name, sku, policy):
        d = {"name": name, "id": az_id("applicationGateways", name), "location": "eastus", "tags": tags,
             "sku": {"name": sku, "tier": sku},
             "frontendIPConfigurations": [{"publicIPAddress": {"id": az_id("publicIPAddresses", "pip-" + name)}}]}
        if policy:
            d["firewallPolicy"] = {"id": f"/subscriptions/{sub_id}/resourceGroups/{rg}/providers/Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies/waf-baseline"}
        return d

    plant(fname, "public_endpoint_without_waf", "Application gateway agw-legacy-quotes uses Standard_v2 with no WAF policy")
    return fname, {
        "_export": {"schema": "azure-subscription-inventory/1.0", "generated": GENERATED, "synthetic": True,
                    "source": "SYNTHETIC SAMPLE: fictional company. Shapes mirror `az network ... list` output."},
        "Subscription": {"id": f"/subscriptions/{sub_id}", "subscriptionId": sub_id,
                         "displayName": "brightwater-prod", "tags": {"AccountRole": "prod", "Environment": "prod"}},
        "VirtualNetworks": vnets,
        "NetworkSecurityGroups": nsgs,
        "PublicIPAddresses": [
            {"name": "pip-agw-claims-portal", "location": "eastus", "ipAddress": "203.0.113.40", "sku": {"name": "Standard"}},
            {"name": "pip-agw-legacy-quotes", "location": "eastus", "ipAddress": "203.0.113.41", "sku": {"name": "Standard"}},
            {"name": "pip-nat-prod", "location": "eastus", "ipAddress": "198.51.100.7", "sku": {"name": "Standard"}},
        ],
        "ApplicationGateways": [agw("agw-claims-portal", "WAF_v2", True), agw("agw-legacy-quotes", "Standard_v2", False)],
        "NatGateways": [{"name": "nat-prod-eus", "id": az_id("natGateways", "nat-prod-eus"), "location": "eastus", "tags": tags}],
        "PrivateEndpoints": [
            {"name": "pe-storage-claims", "location": "eastus", "subnet": {"id": vnets[0]["subnets"][3]["id"]},
             "privateLinkServiceConnections": [{"groupIds": ["blob"]}], "tags": tags},
            {"name": "pe-keyvault-claims", "location": "eastus", "subnet": {"id": vnets[0]["subnets"][3]["id"]},
             "privateLinkServiceConnections": [{"groupIds": ["vault"]}], "tags": tags},
        ],
        "FlowLogs": [{"name": "fl-vnet-prod-eus", "location": "eastus", "enabled": True,
                      "targetResourceId": vnets[0]["id"]}],
    }


fname, doc = build_azure()
write_json(OUT / "azure" / "brightwater-insurance" / fname, doc)


# ---------------------------------------------------------------------------
# GCP: Cobalt Mortgage (fictional), one project
# ---------------------------------------------------------------------------
def build_gcp():
    fname = "cobalt-analytics-project.json"
    proj = "cobalt-analytics-prod"
    base = f"https://www.googleapis.com/compute/v1/projects/{proj}"
    net_url = f"{base}/global/networks/vpc-analytics"

    def sn(name, region, cidr, log=True):
        return {"name": name, "region": f"{base}/regions/{region}", "network": net_url,
                "ipCidrRange": cidr, "privateIpGoogleAccess": True,
                "logConfig": {"enable": log}}

    plant(fname, "default_network_present", "Auto-mode network 'default' still exists")
    plant(fname, "unapproved_region", "Subnet snet-europe-west1 is in europe-west1 (approved: us-east1, us-east4, us-west1)")
    plant(fname, "flow_logs_disabled", "Subnet snet-europe-west1 has flow logs disabled")
    plant(fname, "open_admin_ports", "Firewall rule fw-allow-ssh-any allows tcp:22 from 0.0.0.0/0")
    plant(fname, "public_endpoint_without_waf", "Backend service bs-legacy-report is external with no Cloud Armor policy")

    def fw(name, ranges, ports, proto="tcp"):
        return {"name": name, "network": net_url, "direction": "INGRESS", "priority": 1000,
                "disabled": False, "sourceRanges": ranges, "allowed": [{"IPProtocol": proto, "ports": ports}]}

    return fname, {
        "_export": {"schema": "gcp-project-inventory/1.0", "generated": GENERATED, "synthetic": True,
                    "source": "SYNTHETIC SAMPLE: fictional company. Shapes mirror `gcloud compute ... list` output."},
        "Project": {"projectId": proj, "projectNumber": "512300009900", "name": "cobalt-analytics-prod",
                    "labels": {"accountrole": "prod", "environment": "prod", "owner": "analytics-eng",
                               "costcenter": "cc-6200", "application": "analytics"}},
        "Networks": [
            {"name": "vpc-analytics", "autoCreateSubnetworks": False, "routingConfig": {"routingMode": "GLOBAL"}},
            {"name": "default", "autoCreateSubnetworks": True, "routingConfig": {"routingMode": "REGIONAL"}},
        ],
        "Subnetworks": [sn("snet-us-east1", "us-east1", "10.40.0.0/20"),
                        sn("snet-us-east4", "us-east4", "10.40.16.0/20"),
                        sn("snet-europe-west1", "europe-west1", "10.41.0.0/20", log=False)],
        "Firewalls": [fw("fw-allow-lb-health", ["130.211.0.0/22", "35.191.0.0/16"], ["443"]),
                      fw("fw-allow-iap-ssh", ["35.235.240.0/20"], ["22"]),
                      fw("fw-allow-internal", ["10.40.0.0/16"], ["0-65535"]),
                      fw("fw-allow-ssh-any", ["0.0.0.0/0"], ["22"])],
        "Routers": [{"name": "router-us-east1", "region": f"{base}/regions/us-east1", "network": net_url}],
        "RouterNats": [{"name": "nat-us-east1", "router": "router-us-east1",
                        "natIpAllocateOption": "AUTO_ONLY", "sourceSubnetworkIpRangesToNat": "ALL_SUBNETWORKS_ALL_IP_RANGES"}],
        "ForwardingRules": [{"name": "fr-analytics-https", "region": f"{base}/regions/us-east1",
                             "IPAddress": "203.0.113.20", "loadBalancingScheme": "EXTERNAL_MANAGED",
                             "portRange": "443-443"}],
        "BackendServices": [
            {"name": "bs-analytics-ui", "loadBalancingScheme": "EXTERNAL_MANAGED",
             "securityPolicy": f"{base}/global/securityPolicies/armor-baseline"},
            {"name": "bs-legacy-report", "loadBalancingScheme": "EXTERNAL_MANAGED"},
        ],
        "SecurityPolicies": [{"name": "armor-baseline", "type": "CLOUD_ARMOR"}],
        "VpnTunnels": [],
    }


fname, doc = build_gcp()
write_json(OUT / "gcp" / "cobalt-mortgage" / fname, doc)

# ---------------------------------------------------------------------------
# Answer key
# ---------------------------------------------------------------------------
lines = [
    "# Expected Findings (answer key)",
    "",
    "Every problem the generator planted on purpose, grouped by file. If the dashboard is correct it",
    "reports each row below. Check semantics are in `samples/README.md`. Generated by",
    "`tools/generate_samples.py`; do not edit by hand.",
    "",
]
by_file = {}
for f, c, s, d in PLANTED:
    by_file.setdefault(f, []).append((c, s, d))
for f in sorted(by_file):
    lines += [f"## {f}", "", "| Standard | Check | What was planted |", "|----------|-------|------------------|"]
    for c, s, d in by_file[f]:
        lines.append(f"| {s} | `{c}` | {d} |")
    lines.append("")
lines.append(f"Total planted findings: {len(PLANTED)}")
(OUT / "EXPECTED_FINDINGS.md").write_text("\n".join(lines) + "\n")

print(f"Wrote samples to {OUT}")
print(f"Planted findings: {len(PLANTED)}")
print()
print("AWS per-account counts (compare with dev/counts.html):")
print_aws_counts(TW, (tw_net, tw_prod, tw_non, tw_data, tw_sec))
print_aws_counts(LL, (ll_prod, ll_leg))
