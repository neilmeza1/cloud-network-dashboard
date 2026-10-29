#!/usr/bin/env python3
"""
Run the browser tests (tests/test.html) headlessly and print the results.

Serves the repo root on a free localhost port, loads the test page in headless Chrome or
Edge, and prints what the page reports. Exits 1 if any test fails.

Usage:  python tests/run_tests.py
        python tests/run_tests.py --subfolder   (serve the parent folder and open the site from
                                                 /<repo folder>/, as GitHub Pages will)
        BROWSER=/path/to/chrome python tests/run_tests.py
"""
import functools
import html
import http.server
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

CANDIDATES = [
    os.environ.get("BROWSER"),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    shutil.which("google-chrome"), shutil.which("chromium"), shutil.which("chromium-browser"),
    shutil.which("chrome"), shutil.which("msedge"),
]


def find_browser():
    for c in CANDIDATES:
        if c and Path(c).exists():
            return c
    sys.exit("No Chrome, Chromium or Edge found. Set BROWSER=/path/to/browser.")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".mjs": "text/javascript", ".js": "text/javascript"}

    def log_message(self, *args):
        pass


def main():
    subfolder = "--subfolder" in sys.argv[1:]
    served = ROOT.parent if subfolder else ROOT
    prefix = f"/{ROOT.name}" if subfolder else ""
    handler = functools.partial(QuietHandler, directory=str(served))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}{prefix}/tests/test.html"
    print(f"Serving {served} and opening {prefix or ''}/tests/test.html\n")
    profile = tempfile.mkdtemp(prefix="dashboard-tests-")
    try:
        dom = subprocess.run(
            [find_browser(), "--headless=new", "--disable-gpu", "--no-first-run",
             f"--user-data-dir={profile}", "--virtual-time-budget=120000", "--dump-dom", url],
            capture_output=True, text=True, encoding="utf-8", timeout=120).stdout
    finally:
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    m = re.search(r'<pre id="results"[^>]*>(.*?)</pre>', dom, re.S)
    text = html.unescape(m.group(1)) if m else "FAIL  test page produced no results"
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # results contain severity icons
    print(text)
    sys.exit(0 if "RESULT: PASS" in text else 1)


if __name__ == "__main__":
    main()
