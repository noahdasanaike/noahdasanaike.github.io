"""Build the JSON blob embedded in posts/building-sage.html.

Reconstructed 2026-10-09 from the 2026-08-09 blob (the original generator was lost).
Jekyll skips files that start with an underscore, so this script is not served.

Rules recovered from the 2026-08-09 blob
----------------------------------------
* A country's files are every file under G:/Elections Dataset/Processed/<dir>/ and
  D:/Elections Dataset/Data/<dir>/ (G:/Elections Dataset/Data is a symlink to the
  latter). Directory names are mapped to display names with ALIAS. Output trees
  are not counted.
* "dropped" = files whose mtime is before 2022-01-01 (downloaded or unzipped files
  that kept the publisher's timestamp). The page reports them as "dated before 2022".
  Dropped files are excluded from files, mb, months, first/last and scripts.
* mb = bytes / 1e6 of the kept files, rounded to 0.1. totals.gb = sum(mb) / 1000.
* "script" = a kept file ending .R, .py, .ipynb or .sh (case-insensitive), anywhere in
  the country tree, including .ipynb_checkpoints and node_modules. .Rmd, .qmd, .js,
  .ps1 do not count.
* Dates are local-time (America/New_York) mtimes. months = {YYYY-MM: n} over kept
  files; activeMonths = number of such months; the global months list omits empty
  months; start = 2022-01; end = last month with a file.
* released = the URL-decoded name appears as J:/Output_c_parquet/country=<name>.
  Released countries carry the README national coverage-table columns; partial =
  Progress column is the warning sign; lsage = the country (or "Canada (Quebec)")
  appears in the README LSAGE table. Unreleased countries carry none of these keys.
* A directory with no kept files does not appear.

Extra exclusions applied only to the current run (omit with --legacy)
----------------------------------------------------------------------
* backups and conflict copies: names matching .pre_*, .bak*, *BACKUP*,
  .sync-conflict-*, *.orig, *~ ;
* the 2026-10-05 mirror of Processed downloads into Data/<country>/sage_2026_10_*/
  (copy-time mtimes for files already counted under Processed).

Usage
-----
  python _build_log_data.py --legacy --cutoff 2026-08-07 --readme old_README.md --out old.json
  python _build_log_data.py --html building-sage.html          # current tree, writes page
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.parse

PROCESSED = "G:/Elections Dataset/Processed"
DATA = "D:/Elections Dataset/Data"
RELEASED = "J:/Output_c_parquet"
README = "G:/sage/README.md"

ALIAS = {
    "Capo Verde": "Cabo Verde",
    "Czech": "Czechia",
    "Czech Republic": "Czechia",
    "Kyrgyz Republic": "Kyrgyzstan",
    "Phillipines": "Philippines",
    "United States": "United States of America",
    "Ghana_assessment": "Ghana",
    "Nigeria_assessment": "Nigeria",
}
SKIP_DIRS = {"Users", ".ipynb_checkpoints"}
SCRIPT_EXT = (".r", ".py", ".ipynb", ".sh")
EPOCH = dt.datetime(2022, 1, 1)

JUNK = re.compile(r"(\.pre_|\.bak|backup|\.sync-conflict-|\.orig$|~$)", re.I)
MIRROR = re.compile(r"^sage_2026_10_")


def walk(root, legacy, cutoff):
    """Yield (country, relpath, size, mtime datetime) for one tree."""
    for d in sorted(os.listdir(root)):
        p = os.path.join(root, d)
        if d in SKIP_DIRS or d.startswith(".") or not os.path.isdir(p):
            continue
        name = ALIAS.get(d, d)
        for dp, _, fn in os.walk(p):
            rel_dir = os.path.relpath(dp, p).replace(os.sep, "/")
            top = rel_dir.split("/")[0]
            if not legacy and root == DATA and MIRROR.match(top):
                continue
            for f in fn:
                if not legacy and JUNK.search(f):
                    continue
                try:
                    st = os.lstat(os.path.join(dp, f))
                except OSError:
                    continue
                t = dt.datetime.fromtimestamp(st.st_mtime)
                if cutoff and t >= cutoff:
                    continue
                rel = f if rel_dir == "." else rel_dir + "/" + f
                yield name, rel, st.st_size, t


def released_set():
    out = set()
    for n in os.listdir(RELEASED):
        if n.startswith("country="):
            out.add(urllib.parse.unquote(n.split("=", 1)[1]))
    return out


def cells(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def parse_readme(path):
    """National and LSAGE coverage tables -> ({name: fields}, {lsage names})."""
    text = open(path, encoding="utf8").read()
    nat, lsage, mode = {}, set(), None
    for line in text.splitlines():
        if line.startswith("## "):
            mode = {"## SAGE Country Coverage": "nat",
                    "## LSAGE Country Coverage": "lsage"}.get(line.strip())
            continue
        if not mode or not line.startswith("|"):
            continue
        c = cells(line)
        if c[0] in ("Country", "") or c[0].startswith(":"):
            continue
        if mode == "nat":
            # Country | Years | Polygon Years | Types | Unit | Units/yr | Progress | Source | Geo
            nat[c[0]] = {
                "years": c[1], "types": c[3], "unit": c[4], "unitsPerYear": c[5],
                "polygonYears": c[2], "geoCoverage": c[8], "source": c[7],
                "partial": "\u26a0" in c[6],
            }
        else:
            lsage.add(re.sub(r"\s*\(.*\)$", "", c[0]))
    return nat, lsage


def build(legacy, cutoff, readme, generated):
    rec = {}
    for root in (PROCESSED, DATA):
        for name, rel, size, t in walk(root, legacy, cutoff):
            r = rec.setdefault(name, {"kept": [], "dropped": 0})
            if t < EPOCH:
                r["dropped"] += 1
            else:
                r["kept"].append((rel, size, t))

    rel_set = released_set()
    nat, lsage = parse_readme(readme)
    countries, gmonths = [], {}
    for name in sorted(rec):
        r = rec[name]
        kept = r["kept"]
        if not kept:
            continue
        ts = sorted(t for _, _, t in kept)
        months = {}
        for t in ts:
            k = t.strftime("%Y-%m")
            months[k] = months.get(k, 0) + 1
            gmonths[k] = gmonths.get(k, 0) + 1
        scr = sorted(t for rel, _, t in kept if rel.lower().endswith(SCRIPT_EXT))
        c = {
            "name": name,
            "released": name in rel_set,
            "files": len(kept),
            "mb": round(sum(s for _, s, _ in kept) / 1e6, 1),
            "dropped": r["dropped"],
            "first": ts[0].strftime("%Y-%m-%d"),
            "last": ts[-1].strftime("%Y-%m-%d"),
            "scripts": len(scr),
            "months": dict(sorted(months.items())),
            "scriptMonths": sorted({t.strftime("%Y-%m") for t in scr}),
            "activeMonths": len(months),
        }
        if scr:
            c["firstScript"] = scr[0].strftime("%Y-%m-%d")
            c["lastScript"] = scr[-1].strftime("%Y-%m-%d")
        if c["released"]:
            f = nat.get(name)
            if f is None:
                print("warning: released but not in README table:", name, file=sys.stderr)
                f = {"years": "", "types": "", "unit": "", "unitsPerYear": "",
                     "polygonYears": "", "geoCoverage": "", "source": "", "partial": False}
            c.update(f)
            c["lsage"] = name in lsage
        countries.append(c)

    allm = sorted(gmonths)
    tot = {
        "countries": len(countries),
        "released": sum(c["released"] for c in countries),
        "unreleased": sum(not c["released"] for c in countries),
        "files": sum(c["files"] for c in countries),
        "dropped": sum(c["dropped"] for c in countries),
        "gb": round(sum(c["mb"] for c in countries) / 1000, 1),
        "scripts": sum(c["scripts"] for c in countries),
        "first": min(c["first"] for c in countries),
        "last": max(c["last"] for c in countries),
    }
    return {
        "generated": generated,
        "start": "2022-01",
        "end": allm[-1],
        "totals": tot,
        "months": [{"month": m, "files": gmonths[m]} for m in allm],
        "countries": countries,
    }


def inject(html_path, blob):
    s = open(html_path, encoding="utf8").read()
    pat = re.compile(r'(id="data">)(.*?)(</script>)', re.S)
    if not pat.search(s):
        sys.exit("no data blob found in " + html_path)
    payload = json.dumps(blob, ensure_ascii=False, separators=(",", ":"))
    s = pat.sub(lambda m: m.group(1) + payload + m.group(3), s, count=1)
    open(html_path, "w", encoding="utf8", newline="").write(s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--legacy", action="store_true",
                    help="original rules only (no backup / mirror exclusions)")
    ap.add_argument("--cutoff", help="ignore files with mtime after this date (inclusive)")
    ap.add_argument("--readme", default=README)
    ap.add_argument("--generated", default=dt.date.today().isoformat())
    ap.add_argument("--out", help="write the blob as JSON here")
    ap.add_argument("--html", help="replace the blob inside this page")
    a = ap.parse_args()
    cutoff = None
    if a.cutoff:
        cutoff = dt.datetime.strptime(a.cutoff, "%Y-%m-%d") + dt.timedelta(days=1)
    blob = build(a.legacy, cutoff, a.readme, a.generated)
    if a.out:
        json.dump(blob, open(a.out, "w", encoding="utf8"), ensure_ascii=False, indent=1)
    if a.html:
        inject(a.html, blob)
    print(json.dumps(blob["totals"]))


if __name__ == "__main__":
    main()
