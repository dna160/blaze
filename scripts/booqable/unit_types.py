"""Fill unit_type_slug in kebon-jeruk-units.csv from Booqable rental history.

    python3 scripts/booqable/unit_types.py <fetch-dir> <units-csv> <out-csv>
"""
import json, sys, collections, csv, re
d, units_csv, out_csv = sys.argv[1], sys.argv[2], sys.argv[3]
L = lambda n: json.load(open(f"{d}/{n}.json"))
od = {o["id"]: o for o in L("orders")}; lines = L("lines"); sip = L("stock_item_plannings"); pl = {p["id"]: p for p in L("plannings")}; si = {s["id"]: s for s in L("stock_items")}
line_by_planning = {l["attributes"]["planning_id"]: l for l in lines if l["attributes"].get("planning_id")}
def slug_for(title):
    t = title.lower()
    if "x-large" in t or "x large" in t: return "x-large-storage"
    if "large" in t: return "large-storage"
    if "medium" in t: return "medium-storage"
    if "small" in t: return "small-storage"
    if "free" in t: return "freestyle"
    return None
seen = collections.defaultdict(list)  # identifier -> [(starts_at, slug, title, order#)]
for s in sip:
    a = s["attributes"]
    item = si.get(a.get("stock_item_id"))
    if not item: continue
    ident = item["attributes"]["identifier"]
    p = pl.get(a.get("planning_id"))
    chain = [p] if p else []
    if p and p["attributes"].get("parent_planning_id"): chain.append(pl.get(p["attributes"]["parent_planning_id"]))
    title = None
    for c in chain:
        if c and c["id"] in line_by_planning: title = line_by_planning[c["id"]]["attributes"]["title"]
    o = od.get(a.get("order_id"))
    if o and o["attributes"]["status"] == "canceled": continue
    seen[ident].append((a.get("starts_at") or "", slug_for(title or ""), title, o["attributes"]["number"] if o else None))
rows = list(csv.DictReader(open(units_csv)))
stats = collections.Counter(); conflicts = []
for r in rows:
    hist = sorted(seen.get(r["unit_code"], []))
    slugs = [h[1] for h in hist if h[1]]
    if not slugs:
        r["unit_type_slug"] = r["unit_type_slug"] or ""; stats["no history"] += 1; continue
    latest = slugs[-1]
    if len(set(slugs)) > 1: conflicts.append((r["unit_code"], [(h[3], h[2]) for h in hist]))
    if r["unit_type_slug"] and r["unit_type_slug"] != latest: conflicts.append((r["unit_code"], "data pack says " + r["unit_type_slug"]))
    r["unit_type_slug"] = latest
    r["notes"] = (r["notes"] + "; " if r["notes"] else "") + f"type from Booqable orders ({len(hist)} rentals, latest #{hist[-1][3]})"
    stats[latest] += 1
w = csv.DictWriter(open(out_csv, "w", newline=""), fieldnames=rows[0].keys()); w.writeheader(); w.writerows(rows)
print("units:", len(rows), dict(stats))
print("conflicting history:", len(conflicts)); [print("  ", c) for c in conflicts[:15]]
print("no-history units:", [r["unit_code"] for r in rows if not r["unit_type_slug"]])
others = {k: collections.Counter(h[1] for h in v) for k, v in seen.items() if not k.startswith("STORAGE-")}
print("non-STORAGE stock items rented:", len(others))
