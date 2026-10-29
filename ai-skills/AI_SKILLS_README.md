# CAPS AI Skills

AI-assisted skills for the **Cloud Architecture & Platform Strategy (CAPS)** team at Kestrel Ridge Financial, a fictional company used for a portfolio project. The skills encode team knowledge, standards and workflows so AI agents produce consistent, compliant output across the governance lifecycle.

---

## What Are Skills?

Skills are structured prompt files that give an AI agent the context to perform a specific team workflow. They encode standards, constraints and operational knowledge. Think of them as runbooks an agent can execute.

| Platform | Location | Invoke |
|----------|----------|--------|
| Claude Code (CLI, desktop, VS Code) | `claude-code/<name>.md` | `/<name>` in any Claude Code session |
| GitHub Copilot (VS Code) | `copilot-prompts/<name>.prompt.md` | `#<name>` in Copilot Chat |
| Copilot workspace context | `copilot-instructions/<name>.md` | Auto-loaded or attached as context |

---

## Governance Lifecycle

Skills map to the CAPS delivery lifecycle:

```
Identify Need ────────────── (conversation / requirements gathering)
      │
      ▼
Assess Environment ───────── /analyze-cloud-export (acquisitions and existing accounts)
      │
      ▼
Architecture Design ──────── /architecture-rfc (Phase 1-2)
      │
      ▼
Diagrams + RFC + ADR ─────── /architecture-rfc (Phase 3-5)
      │
      ▼
Review Board Sign-Off ────── /prepare-review-pack
      │
      ▼
Implementation (IaC) ─────── /new-iac-project (scaffolding)
      │
      ▼
Operate ──────────────────── (monitoring, runbooks, day 2)
```

---

## Available Skills

Status values: **Planned** (not built yet), **Draft** (works, still changing), **Stable**. Update this table as skills are built.

### Claude Code Commands (`claude-code/`)

| Skill | Description | Status |
|-------|-------------|--------|
| `analyze-cloud-export` | Parse AWS, Azure or GCP inventory JSON, evaluate it against `Cloud_Standards.yaml`, and produce dashboard data | Planned |
| `architecture-rfc` | Guide an architecture decision from requirements through diagrams, RFC and ADR | Planned |
| `prepare-review-pack` | Build the Architecture Review Board slide pack from the IaC and the RFC | Planned |
| `new-iac-project` | Scaffold an infrastructure as code project: repo layout, pipeline, policy checks | Planned |

### Copilot Prompts (`copilot-prompts/`)

| Prompt | Description | Status |
|--------|-------------|--------|
| `architecture-rfc` | Same workflow as the Claude Code skill, adapted for Copilot context limits | Planned |
| `new-iac-project` | Scaffold a new infrastructure project: repo plus pipeline | Planned |

### Copilot Instructions (`copilot-instructions/`)

Workspace-level context files that auto-load when you open a project in VS Code. They give Copilot awareness of project conventions, architecture and guardrails.

| File | Project | Status |
|------|---------|--------|
| `dashboard-app.md` | Conventions for the cloud network dashboard web app | Planned |
| `iac-modules.md` | Conventions for the shared infrastructure modules repo | Planned |

---

## Skill Spotlight: `analyze-cloud-export`

This is the skill the dashboard project is built around.

**Input:** one or more inventory JSON files. Each file is one AWS account, Azure subscription or GCP project. Files from the same company are analyzed together.

**Reads:** `Cloud_Standards.yaml`, specifically `config` (approved regions, admin ports, required tags) and each mandate's `check` and `severity`.

**Produces:** a single `dashboard-data.json` with these parts, in this order:

| Part | Contents |
|------|----------|
| `overview` | Account count, regions, availability zones, networks, subnets, internet gateways, transit attachments, endpoints, network interfaces, public rules |
| `findings` | One row per finding: severity, standard ID, what was found, where (file and path), recommended action |
| `network_map` | Public entry points, regional network layout, shared network services |
| `accounts` | One row per file: role, networks, CIDRs, counts |
| `standards_gaps` | Mandates that cannot be verified from the export (`check: manual`) and the evidence needed |

**Rules the skill follows:**

1. Every number comes from the uploaded files. If something is not in the export, write "not in export". Never estimate or invent.
2. Every finding cites a standard ID and the file and path that proves it.
3. Each fact appears in one place. Counts live in `overview` and `accounts`; problems live in `findings`; unverifiable standards live in `standards_gaps`. Nothing is repeated across sections.
4. AWS, Azure and GCP exports are normalized into the same model (account, network, subnet, gateway, firewall rule, public endpoint) before checks run.
5. Spell out jargon the first time it appears (for example: VPC endpoint, security group).

---

## Installation

### Claude Code

Copy (or symlink) the command files into your Claude Code commands directory:

```bash
# Copy all Claude Code skills
cp claude-code/*.md ~/.claude/commands/

# Or symlink for auto-updates when you pull
ln -sf $(pwd)/claude-code/*.md ~/.claude/commands/
```

Skills are available as `/<name>` in your next Claude Code session.

### GitHub Copilot

Copy the prompt files into any repo's `.github/prompts/` directory:

```bash
# From within your project repo
mkdir -p .github/prompts
cp /path/to/ai-skills/copilot-prompts/*.prompt.md .github/prompts/
```

For workspace-level instructions, copy to `.github/copilot-instructions.md`:

```bash
cp /path/to/ai-skills/copilot-instructions/<relevant>.md .github/copilot-instructions.md
```

---

## Design Principles

All skills encode these team standards:

| Principle | How Skills Enforce It |
|-----------|----------------------|
| **IaC-first** | Scaffolds wire the approved pipeline; assessments read `.tf` files when present |
| **Safety rails** | Skills analyze and propose; they never change live environments |
| **ADR-driven** | The architecture skill produces decision records; later skills reference them |
| **Compliance as default** | PCI-DSS, SOC 2, ISO 27001 and NIST CSF are assumed as the baseline, not optional |
| **Evidence over opinion** | Findings cite the file and path that proves them |
| **Artifacts over meetings** | Skills produce durable documents (RFC, ADR, slides, diagrams, dashboard data) |
| **Opinionated defaults** | Approved regions, required tags and the address plan are fixed in `Cloud_Standards.yaml` |
| **Validate before act** | Compare alternatives before recommending; check inputs before analyzing |

---

## Contributing

Add or change a skill by editing its file, updating the Status column above, and testing it against the sample exports in `samples/` (see `samples/EXPECTED_FINDINGS.md` for the answer key). Changes to `Cloud_Standards.yaml` require a version bump in its `meta` block.

---

## Further Reading

- [Cloud Standards](Cloud_Standards.yaml) - mandates, principles and the values the checks read
- [Sample data guide](../samples/README.md) - export formats and how the samples were built
- [Expected findings](../samples/EXPECTED_FINDINGS.md) - answer key for testing the dashboard

---

*Maintained by the CAPS team - Cloud Architecture & Platform Strategy, Kestrel Ridge Financial (fictional)*
