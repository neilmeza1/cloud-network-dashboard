# Sample Data

All files here are **synthetic**. The companies (Tidewater Payments, Larkspur Lending, Brightwater Insurance, Cobalt Mortgage) and all account IDs, addresses and names are made up. IP addresses come from reserved documentation ranges. Regenerate everything with:

```bash
python tools/generate_samples.py
```

The generator uses a fixed seed, so the output is identical every time. It also rewrites `EXPECTED_FINDINGS.md`, the answer key listing every problem it planted.

## Layout

| Folder | Company | Files | Character |
|--------|---------|-------|-----------|
| `aws/tidewater-payments/` | Tidewater Payments | 5 accounts | Mostly well run, a handful of planted problems |
| `aws/larkspur-lending/` | Larkspur Lending | 2 accounts | Messy, like an estate that arrives with an acquisition |
| `azure/brightwater-insurance/` | Brightwater Insurance | 1 subscription | Small, a few problems |
| `gcp/cobalt-mortgage/` | Cobalt Mortgage | 1 project | Small, a few problems |

One file is one AWS account, Azure subscription or GCP project. A company is a folder of files; the dashboard analyzes a whole folder together (some checks, like address overlap, compare files).

## AWS file format (`aws-account-inventory/1.0`)

The shapes inside mirror AWS CLI `describe-*` output, so a real export can be reshaped into this format with a small script.

```
{
  "_export":  { schema, generated, synthetic, source },
  "Account":  { AccountId, AccountName, Company, Tags: { AccountRole, Environment, Owner } },
  "Regions": {
    "<region>": {
      Vpcs, Subnets, RouteTables, InternetGateways, NatGateways,
      TransitGateways, TransitGatewayAttachments, VpcEndpoints, NetworkInterfaces,
      SecurityGroups, VpcPeeringConnections, FlowLogs,
      LoadBalancers, Listeners, WebAcls, WebAclResources
    }
  },
  "Global": { CloudFrontDistributions, WebAclsGlobal }
}
```

Notes for whoever writes the parser:

- A VPC peering appears in both accounts' files with the same `VpcPeeringConnectionId`. Count it once.
- Transit gateway attachments from other accounts also appear in the owning account's file (same attachment id). Count each id once.
- Load balancer to WAF links live in `WebAclResources`, not on the load balancer itself (that is how AWS reports it).
- Network interface types matter: `nat_gateway`, `vpc_endpoint` and load balancer interfaces (description starts with `ELB `) are infrastructure. Interfaces of type `interface` with any other description stand in for workloads.

## Azure and GCP formats

- `azure-subscription-inventory/1.0`: `Subscription`, `VirtualNetworks`, `NetworkSecurityGroups`, `PublicIPAddresses`, `ApplicationGateways`, `NatGateways`, `PrivateEndpoints`, `FlowLogs`.
- `gcp-project-inventory/1.0`: `Project`, `Networks`, `Subnetworks`, `Firewalls`, `Routers`, `RouterNats`, `ForwardingRules`, `BackendServices`, `SecurityPolicies`, `VpnTunnels`.

## What each check means

Check ids come from `Cloud_Standards.yaml`. Values in `config` are read from that file.

| Check | Standard | Triggers when (AWS) |
|-------|----------|---------------------|
| `account_role_tag_present` | NET-01 | `Account.Tags.AccountRole` is missing |
| `default_network_present` | NET-02 | A VPC has `IsDefault: true` |
| `cidr_overlap` | NET-03 | Two VPC CIDRs in the same company folder overlap |
| `workload_in_public_subnet` | NET-04 | A workload interface (see above) has `Association.PublicIp` |
| `public_endpoint_without_waf` | NET-05 | An internet-facing load balancer is not in `WebAclResources`, or a CloudFront distribution has an empty `WebACLId` |
| `open_admin_ports` | NET-06 | A security group rule from `0.0.0.0/0` has a tcp port range covering `config.admin_ports` |
| `open_to_world_non_web` | NET-07 | A rule from `0.0.0.0/0` allows all traffic (`-1`) or a range covering `config.database_ports` (admin-port rules are reported by NET-06, not here) |
| `missing_private_endpoints` | NET-08 | A VPC has workload interfaces and no S3 gateway endpoint |
| `nat_not_per_az` | NET-09 | A VPC has NAT gateways in fewer availability zones than the VPC spans |
| `flow_logs_disabled` | NET-10 | A VPC has no `ACTIVE` flow log |
| `peering_present` | NET-11 | Any active peering connection exists (count each id once) |
| `unapproved_region` | SEC-04 | A region key is not in `config.approved_regions.aws` |
| `plain_http_listener` | DAT-01 | A listener on an internet-facing load balancer uses `HTTP` with a non-redirect default action |
| `single_az_network` | RES-01 | A VPC tagged `Environment: prod` spans fewer than `config.min_azs_for_prod` zones |
| `missing_required_tags` | OPS-01 | A non-default VPC lacks any tag in `config.required_tags` |

Azure and GCP use the closest equivalent signal: network security groups and firewall rules for the rule checks, application gateway SKU and backend service security policy for the WAF check, and subnet or flow log settings for flow logs.

## Using real data

Real exports belong in `private-data/` (ignored by git). Never put them in `samples/`, never commit them, and never upload them to a public site. To collect your own AWS data, run the matching `aws ec2 describe-*`, `aws elbv2 describe-*` and `aws wafv2 ...` commands per region and merge the results into the format above. Free open-source tools that inventory cloud accounts are another source of realistic JSON to study.
