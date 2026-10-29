# Dashboard Design

Design spec for the Cloud Network Dashboard. It replaces an earlier dashboard that put the same numbers in many places. Read this before building any page.

## What was wrong with the earlier design

Reviewed from a screenshot of the previous dashboard (a photo, so counts are approximate):

1. **The same facts repeated.** The VPC count appeared in about four places, the single observed region in about nine, and the transit gateway and peering counts in about five. A reader cannot tell which copy to trust or whether they mean different things.
2. **Boilerplate stood in for evidence.** A "network practices" column printed the same sentence for every account. That reads as a conclusion, not something found in the files.
3. **Inference looked like fact.** "Multi-region DR evidence is missing" was derived from seeing one region, but was displayed like a measurement.
4. **Numbers had no definitions.** A tile such as "Public SG" does not say what it counts.
5. **Color meant nothing.** Tiles turned red without a stated rule.
6. **No hierarchy.** About ten panels were visible at once, all the same weight.
7. **The diagram was a template.** It repeated the page title, its own legend and a footer of address blocks that the routing table already listed.

## Principles

- **One home per fact.** Every number or statement appears in exactly one place. Other places link to it.
- **Three kinds of statement, always labeled:** *Observed* (read from the file), *Finding* (a check against a standard failed), *Not in export* (the file cannot answer it). Never mix them.
- **Color only means severity.** Everything else is neutral.
- **Every number has a definition** (hover or tap).
- **Evidence on demand.** Each finding expands to show the file, the JSON path and the raw snippet.
- **Structure over counts in the diagram.** The map shows how things connect, built from the data, not a fixed template.

## Page structure

Five sections in a sticky top nav, in the order a reader asks questions.

```
+--------------------------------------------------------------------+
|  <company name from the files>  [Overview] [Findings] [Map] [Accounts] [Gaps]  [Upload] |
+--------------------------------------------------------------------+
| OVERVIEW   What am I looking at?                                   |
|  Tidewater Payments: 5 accounts, 1 region, 12 VPCs   (one scope line)|
|  [Accounts] [VPCs] [Subnets] [Internet-facing] [Peerings+TGW] [Findings by severity bar] |
+--------------------------------------------------------------------+
| FINDINGS   What is wrong?                                          |
|  filters: severity | account | standard | search                    |
|  HIGH  NET-06  Admin port open to the world   acct-x  vpc-y   [v]  |
|        (expands: file, path, snippet, why it matters, standard text)|
+--------------------------------------------------------------------+
| MAP        How does it connect?                                    |
|  Internet edge                                                     |
|     |                                                              |
|  [account: shared-network] --TGW-- [account: prod-app] ...         |
|     VPC name + CIDR inside each account box; peerings as dashed lines|
|  flagged nodes outlined by severity; click a node to filter Findings|
+--------------------------------------------------------------------+
| ACCOUNTS   What is in each one?                                    |
|  one table, one row per account, expands to its VPCs, CIDRs,       |
|  subnets by tier, default routes, endpoints, NAT per zone          |
+--------------------------------------------------------------------+
| GAPS       What can we not tell from these files?                  |
|  manual standards (no automated check) and items "Not in export"   |
+--------------------------------------------------------------------+
```

## Single home for each fact

| Fact | Lives in | Everywhere else |
|------|----------|-----------------|
| Account, region, zone, VPC, subnet counts | Overview | Not repeated. Accounts table shows per-account counts only (different fact). |
| Internet-facing counts (internet gateways, public load balancers, CDN distributions) | Overview | Findings cite specific items, not totals. |
| Transit gateway and peering counts | Overview | Map draws the connections themselves. |
| Findings (what, severity, standard, evidence) | Findings | Overview shows only counts by severity. Map and Accounts show a severity outline that links to Findings. |
| VPC name and address range | Accounts (expanded row) | Map labels reuse the same data but it is one source. |
| Routing summary per VPC | Accounts (expanded row) | Not repeated. |
| Observed regions | Overview scope line | Region is a column in Accounts, nowhere else. |
| Disaster recovery or other unprovable items | Gaps | Never in Overview or Findings. |
| Standard text (statement, why) | Findings (expanded) and Gaps | Shown from `Cloud_Standards.yaml`, never retyped. |

## Old section to new section

| Earlier section | Now |
|-----------------|-----|
| Ten metric tiles | Overview, six tiles with definitions. Lower-level counts (network interfaces, endpoints) move into the Accounts detail. |
| Executive Summary (four boxes) | Overview scope line. The facts were already in the tiles. |
| Architecture diagram image | Map, generated from the data. |
| Priority Tasks | Findings, sorted by severity. Optional "reviewed" checkbox stored in the browser. |
| Region / DR Signal | Gaps (it is a "Not in export" item), not a panel. |
| Organization Accounts / Network Practices | Accounts table. Boilerplate practice text removed. |
| Accounts / Environments cards | Merged into the Accounts table. |
| Transit Gateway panel | Overview tile and Map edges. |
| Network Service Inventory | Removed. Duplicate of the Overview tiles. |
| CIDR / VPC / Routing table | Accounts, expanded row. |
| Standards / Missing Evidence | Gaps. |

## Behavior

- **Upload:** drag and drop one or many files, or a whole folder. Group files into a company by folder name (use `webkitRelativePath`). AWS files also carry `Account.Company`. Azure and GCP files have no company field, so group those by folder, or ask the user to type a name.
- **Detect format** from `_export.schema` (`aws-account-inventory/1.0`, `azure-subscription-inventory/1.0`, `gcp-project-inventory/1.0`). Unknown schema: show a clear error naming the file.
- **Sample buttons:** "Load Tidewater (AWS)", "Load Larkspur (messy AWS)", "Load Brightwater (Azure)", "Load Cobalt (GCP)". Samples are fetched from `samples/` in the repo.
- **Standards:** read `ai-skills/Cloud_Standards.yaml` at load. Take thresholds from `config`, never hard-code them. Vendor the YAML parser into the repo (no CDN) so the site works offline and on GitHub Pages.
- **Single model:** parse each cloud into one normalized structure (accounts, networks, subnets, gateways, endpoints, firewall rules, load balancers, peerings, logging flags), run the checks on that, then build `dashboard-data.json` (see `ai-skills/AI_SKILLS_README.md`). Render only from that object. Add a "Download dashboard-data.json" button.
- **Privacy line in the header:** "Files are read in your browser and never uploaded."
- **Look:** light and dark themes, a print stylesheet, keyboard-navigable, no color-only meaning (pair color with an icon or word).
- **Empty and error states:** a file with a missing section shows "Not in export", never zero.

## Glossary (tooltips and first use)

- **VPC (virtual private cloud):** an isolated private network inside a cloud account.
- **Subnet:** a slice of a VPC in one availability zone. Public if it routes to an internet gateway.
- **Internet gateway (IGW):** the door between a VPC and the public internet.
- **NAT gateway:** lets private resources reach out to the internet without being reachable from it.
- **Transit gateway (TGW):** a hub that connects many VPCs and accounts.
- **VPC endpoint:** a private connection from a VPC to a cloud service that avoids the public internet.
- **Network interface (ENI):** the virtual network card a resource plugs into.
- **Security group (SG):** a virtual firewall listing who may connect on which ports.
- **WAF (web application firewall):** filters malicious web requests in front of a public site.
- **Availability zone (AZ):** a separate data center building within a region.

## Build order

Each step ends with something you can open and check.

1. **AWS parser and normalizer.** Load the Tidewater and Larkspur files; print a count summary. Compare with the per-account counts printed by `tools/generate_samples.py`.
2. **Checks engine** driven by `config` in the YAML. Test: the 28 AWS rows in `samples/EXPECTED_FINDINGS.md` are all reported, and nothing else.
3. **Overview and Findings** (upload, filters, expandable evidence).
4. **Accounts** table with expandable rows.
5. **Map** as inline SVG, nodes grouped by account, edges for transit gateway attachments and peerings, severity outlines, click to filter Findings.
6. **Gaps** from the `check: manual` mandates plus every "Not in export" item.
7. **Azure and GCP normalizers.** Test: the Azure and GCP rows in the answer key appear.
8. **Polish:** themes, print stylesheet, accessibility pass, empty states, README with screenshots (of sample data only).

## Acceptance checklist

- Loading all AWS samples reproduces every AWS row in the answer key, with no extras.
- Loading the Azure and GCP samples reproduces their rows.
- Search the page text: no count appears in two sections. (Per-account counts in Accounts are allowed because they are a different fact.)
- Every finding has severity, standard ID, description, file and path.
- After the page has loaded, going offline does not break uploading and analyzing your own files.
- No file in the repo mentions a real employer or contains real data.
