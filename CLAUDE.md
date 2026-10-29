# Project: Cloud Network Dashboard (portfolio project)

A static web app. A user uploads a cloud inventory JSON export (AWS first; Azure and GCP too) and the page builds a clean, organized network dashboard. The company is fictional (Kestrel Ridge Financial) and all sample data is synthetic.

## Read first
- `docs/DASHBOARD_DESIGN.md` - page structure, single-home table for every fact, build order, acceptance checklist. Follow it.
- `ai-skills/Cloud_Standards.yaml` - the standards findings map to (`config` values and each mandate's `check` id)
- `ai-skills/AI_SKILLS_README.md` - team conventions and the `analyze-cloud-export` contract (what the dashboard data must contain)
- `samples/README.md` - export formats and check semantics
- `samples/EXPECTED_FINDINGS.md` - answer key; the dashboard must report every row

## Rules
- Static site only (HTML, CSS, JavaScript). No backend. Parsing happens in the browser and uploaded files never leave it.
- Every number comes from the uploaded files. If something is not in the export, show "not in export". Never guess.
- Each fact appears once. Sections: Overview, Findings, Network map, Accounts, Standards gaps.
- Each finding shows severity, standard ID, what was found, and the file and path that proves it.
- Normalize AWS, Azure and GCP into one model before running checks.
- Spell out jargon on first use (for example: VPC endpoint, security group).
- Never commit real data. Real exports go in `private-data/`, which is git-ignored.
- Do not reference any real employer's internal names, systems or files. Do not copy screenshots of any real dashboard into the repo.
- Label every statement as Observed, Finding or Not in export. Color only means severity.
- Work in the build order from the design doc, one step at a time, and stop after each step so the result can be checked.

## Commands
On this machine Python is `python`, not `python3`.
- `python -m http.server 8000` then open http://localhost:8000/ to run the site (ES modules do not load from `file://`)
- `python tests/run_tests.py` runs every test in headless Chrome or Edge; exits non-zero on failure
- `python tests/run_tests.py --subfolder` runs them with the site opened from `/<repo folder>/`, as GitHub Pages will
- `python tests/make_broken_fixtures.py` regenerates the broken copies in `tests/fixtures/broken/`
- `python tools/generate_samples.py` regenerates the synthetic samples and the answer key, and prints per-account AWS counts to compare with http://localhost:8000/dev/counts.html
