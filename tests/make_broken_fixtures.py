#!/usr/bin/env python3
"""
Write deliberately broken copies of sample files to tests/fixtures/broken/ for the
"not in export" tests. Kept outside samples/ so they never mix with the real samples.

Usage:  python tests/make_broken_fixtures.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "fixtures" / "broken"
OUT.mkdir(parents=True, exist_ok=True)

# larkspur-prod with sections removed. Checks that read them must report
# "not in export" instead of a finding, and counts that read them must not show 0.
doc = json.loads((ROOT / "samples" / "aws" / "larkspur-lending" / "larkspur-prod.json").read_text())
doc["_export"]["source"] = "DELIBERATELY BROKEN test copy of samples/aws/larkspur-lending/larkspur-prod.json"
del doc["Account"]["Tags"]                 # NET-01 cannot be checked
region = doc["Regions"]["us-east-1"]
for key in ("FlowLogs", "VpcEndpoints", "WebAclResources"):  # NET-10, NET-08, NET-05
    del region[key]
del doc["Global"]                          # CloudFront not in export
(OUT / "larkspur-prod-broken.json").write_text(json.dumps(doc, indent=2) + "\n", newline="\n")

# A file whose schema the dashboard does not know.
unknown = {"_export": {"schema": "oracle-tenancy-inventory/1.0", "synthetic": True}, "Tenancy": {}}
(OUT / "unknown-schema.json").write_text(json.dumps(unknown, indent=2) + "\n", newline="\n")

# A file that is not valid JSON.
(OUT / "not-json.json").write_text('{"_export": {"schema": "aws-account-inventory/1.0",\n', newline="\n")

print(f"Wrote broken fixtures to {OUT}")
