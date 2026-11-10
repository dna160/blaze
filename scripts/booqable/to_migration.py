"""Booqable export (JSON from fetch.py) -> the RentOS legacy-migration CSVs (PRD go-live §10).

    python3 scripts/booqable/to_migration.py <fetch-dir> <units-csv> <out-dir> [today YYYY-MM-DD]

Writes migration-customers.csv, migration-rentals.csv, migration-open-invoices.csv
(for `pnpm migrate:legacy`), units-full.csv (the 172 STORAGE units plus Booqable's
X-Large and Freestyle stock items, for `pnpm import:units`) and REVIEW-*.csv lists.
Output holds customer PII: keep it out of the repository.

How Booqable maps onto RentOS (verified against the 2026-11-10 export):
- A rental is one (customer, unit) pair across that customer's started/reserved
  orders. Booqable puts each renewal in its own order; the chain is one RentOS lease.
- Unit size: Booqable has one "Storage" product; the size is the order line's
  title ("Small Storage" ...), linked to the physical unit through the line's
  planning -> child planning -> stock item planning.
- Monthly rent = the line's price per unit divided by its charge period
  ("3 Months", "12 months", "1 Year"); a Rp 0 free-month promo falls back to the
  latest non-zero price, else the quotation list price.
- Deposits are on the invoice/contract documents, rarely on the order.
- paid_through = the end of the latest started/reserved period: unpaid periods are
  carried as open invoices, so nothing is billed twice.
- Multi-unit contracts get a "/<unit>" suffix (RentOS has one contract per unit
  rental); legacySequence() still reads the running number through it.
"""
import json, sys, csv, collections, datetime, os
d, units_typed, out = sys.argv[1], sys.argv[2], sys.argv[3]
TODAY = sys.argv[4] if len(sys.argv) > 4 else datetime.date.today().isoformat()
os.makedirs(out, exist_ok=True)
L = lambda n: json.load(open(f"{d}/{n}.json"))
cu = {c["id"]: c for c in L("customers")}; od = {o["id"]: o for o in L("orders")}; lines = L("lines")
sip = L("stock_item_plannings"); pl = {p["id"]: p for p in L("plannings")}; si = {s["id"]: s for s in L("stock_items")}; docs = L("documents")
UNIT_TYPE = {r["unit_code"]: r["unit_type_slug"] for r in csv.DictReader(open(units_typed))}
line_by_planning = {l["attributes"]["planning_id"]: l for l in lines if l["attributes"].get("planning_id")}
day = lambda ts: (ts or "")[:10]

def type_slug(title, price):
    t = (title or "").lower()
    if "x-large" in t or "x large" in t: return "x-large-storage"
    if "free" in t:
        return {320000: "free-style-1", 610000: "free-style-2", 900000: "free-style-3"}.get(price, "free-style-1")
    if "large" in t: return "large-storage"
    if "medium" in t: return "medium-storage"
    if "small" in t: return "small-storage"
    return None

# unit plannings per order: (identifier, type line title, monthly price)
unit_rows = collections.defaultdict(list)
for s in sip:
    a = s["attributes"]; it = si.get(a["stock_item_id"]); o = od.get(a["order_id"])
    if not it or not o: continue
    p = pl.get(a["planning_id"]); line = None
    for c in [p, pl.get(p["attributes"].get("parent_planning_id")) if p else None]:
        if c and c["id"] in line_by_planning: line = line_by_planning[c["id"]]
    price = None
    if line:
        la = line["attributes"]; label = (la.get("charge_label") or "").lower()
        import re
        m = re.search(r"(\d+)\s*(month|bulan)", label)
        months = int(m.group(1)) if m else 12 if ("year" in label or "tahun" in label) else 1 if ("month" in label or "bulan" in label) else None
        if months is None:  # no charge label: fall back to the order's own length
            oa = o["attributes"]
            try:
                dd = (datetime.date.fromisoformat(day(oa["stops_at"])) - datetime.date.fromisoformat(day(oa["starts_at"]))).days
                months = max(1, round(dd / 30.4))
            except Exception:
                months = 1
        price = round(la["price_each_in_cents"] / 100 / months)
    unit_rows[o["id"]].append((it["attributes"]["identifier"], line["attributes"]["title"] if line else None, price))

ACTIVE = ("started", "reserved")
chains = collections.defaultdict(list)  # (customer_id, unit) -> [order]
for oid, units in unit_rows.items():
    o = od[oid]; a = o["attributes"]
    if a["status"] not in ACTIVE: continue
    for (u, title, price) in units:
        chains[(a["customer_id"], u)].append((o, title, price))

contracts_by_order = collections.defaultdict(list); invoices_by_order = collections.defaultdict(list)
for x in docs:
    a = x["attributes"]
    if a.get("archived"): continue
    if a["document_type"] == "contract": contracts_by_order[a["order_id"]].append(x)
    if a["document_type"] == "invoice": invoices_by_order[a["order_id"]].append(x)

rentals, used_contract = [], collections.Counter()
order_first_row = {}  # order id -> booking number of its first unit row (for open invoices)
notes = collections.Counter()
for (cid, unit), items in sorted(chains.items(), key=lambda kv: (cu[kv[0][0]]["attributes"]["number"], kv[0][1])):
    items.sort(key=lambda t: t[0]["attributes"]["starts_at"])
    first, last = items[0][0], items[-1][0]
    multi = len(unit_rows[first["id"]]) > 1
    booking = f"{first['attributes']['number']}/{unit}"
    cdocs = sorted(contracts_by_order[first["id"]] or [c for (o, _, _) in items for c in contracts_by_order[o["id"]]], key=lambda c: c["attributes"]["created_at"])
    cnum = cdocs[-1]["attributes"]["prefix_with_number"] if cdocs else f"BQ-{first['attributes']['number']}"
    if not cdocs: notes["rental without a Booqable contract document"] += 1
    if multi or used_contract[cnum]: cnum = f"{cnum}/{unit}"
    used_contract[cnum] += 1
    # A free-month promo order has a Rp 0 line; the rent is the latest NON-zero price in the
    # chain, else the unit type's list price from the quotation.
    LIST = {"small-storage": 1100000, "medium-storage": 2100000, "large-storage": 4100000, "x-large-storage": 7200000,
            "free-style-1": 320000, "free-style-2": 610000, "free-style-3": 900000}
    nonzero = [pr for (_, _, pr) in items if pr]
    price = nonzero[-1] if nonzero else LIST.get(type_slug(items[-1][1], 0) or UNIT_TYPE.get(unit, "") or "", 0)
    if not nonzero: notes["rental priced from the list price (only Rp 0 promo orders)"] += 1
    units_in_first = max(1, len(unit_rows[first["id"]]))
    # Booqable rarely records the deposit on the order (deposit_type none); the invoice/contract
    # documents carry it. Take the largest deposit shown on any document of the chain's first order,
    # else of any order in the chain, split evenly over that order's units.
    def doc_deposit(oid):
        vals = [max(x["attributes"].get("deposit_paid_in_cents") or 0, x["attributes"].get("deposit_in_cents") or 0) for x in invoices_by_order[oid] + contracts_by_order[oid]]
        return max(vals) if vals else 0
    dep_cents = doc_deposit(first["id"]) or max([doc_deposit(o["id"]) for (o, _, _) in items] + [0]) or (first["attributes"].get("deposit_paid_in_cents") or 0)
    deposit = round(dep_cents / 100 / units_in_first)
    if not dep_cents: notes["rental with no deposit on any Booqable document"] += 1
    end = max(day(o["attributes"]["stops_at"]) for (o, _, _) in items)
    # Billed through = the end of the latest period that is either paid or carried as an open invoice,
    # so the recurring job bills the NEXT period and nothing twice.
    billed = end
    status_note = "; ".join(sorted({f"#{o['attributes']['number']} {o['attributes']['status']}/{o['attributes']['payment_status']}" for (o, _, _) in items}))
    for (o, _, _) in items: order_first_row.setdefault(o["id"], booking)
    rentals.append({
        "legacy_booking_number": booking, "legacy_contract_number": cnum, "legacy_customer_number": cu[cid]["attributes"]["number"],
        "unit_code": unit, "unit_type_slug": type_slug(items[-1][1], price) or "", "start_date": day(first["attributes"]["starts_at"]),
        "current_period_end": end, "monthly_price_idr": price, "deposit_held_idr": deposit, "paid_through": billed, "status": "ACTIVE",
        "signed_contract_pdf": "", "notes": f"Booqable orders {status_note}" + (f"; deposit split over {units_in_first} units" if units_in_first > 1 else ""),
    })

active_customers = {r["legacy_customer_number"] for r in rentals}
props = collections.defaultdict(dict)
for c in cu.values(): props[c["id"]] = c["attributes"].get("properties") or {}
customers = []
for c in sorted(cu.values(), key=lambda c: c["attributes"]["number"]):
    a = c["attributes"]
    if a["number"] not in active_customers: continue
    p = props[c["id"]]
    addr = (p.get("main_address") or "").replace("\r", "")
    addr_lines = [l.strip() for l in addr.split("\n") if l.strip() and l.strip().lower() != "indonesia"]
    if addr_lines and addr_lines[0].upper() == (a["name"] or "").strip().upper(): addr_lines = addr_lines[1:]
    business = a.get("legal_type") == "commercial"
    customers.append({
        "legacy_customer_number": a["number"], "customer_type": "BUSINESS" if business else "INDIVIDUAL",
        "full_name": (p.get("pic_name") or a["name"] or "").strip() if business else (a["name"] or "").strip(),
        "company_name": (a["name"] or "").strip() if business else "",
        "phone_e164": p.get("phone") or p.get("pic_phone") or "", "email": a.get("email") or "",
        "address_line": ", ".join(addr_lines), "city": "", "postal_code": "",
        "ktp_number": "" if business else (p.get("nik_paspor_nib") or ""), "npwp": p.get("npwp") or "", "nib": (p.get("nik_paspor_nib") or "") if business else "",
        "pph_withheld": "", "notes": f"Booqable customer #{a['number']}" + (f"; PIC phone {p.get('pic_phone')}" if p.get("pic_phone") and business else ""),
    })

open_invoices, outside = [], []
drafts = []
for oid, invs in invoices_by_order.items():
    # A revised invoice keeps its number; only the latest revision is the live one.
    latest = {}
    for x in invs:
        n = x["attributes"]["prefix_with_number"] or str(x["attributes"]["number"])
        if n not in latest or (x["attributes"].get("revision") or 0) > (latest[n]["attributes"].get("revision") or 0): latest[n] = x
    for x in latest.values():
        a = x["attributes"]
        if a["status"] != "payment_due": continue
        if not a.get("finalized") or not a.get("date"):
            drafts.append({"legacy_invoice_number": a["prefix_with_number"] or str(a["number"]), "legacy_booking_number": order_first_row.get(oid, ""), "invoice_date": a.get("date") or "", "due_date": a.get("due_date") or "", "period_start": day(a["starts_at"]), "period_end": day(a["stops_at"]), "amount_idr": round(a["grand_total_in_cents"] / 100), "amount_paid_idr": round((a["paid_in_cents"] or 0) / 100), "status": "DRAFT", "notes": "not finalized in Booqable"})
            continue
        row = {"legacy_invoice_number": a["prefix_with_number"] or str(a["number"]), "legacy_booking_number": order_first_row.get(oid, ""),
               "invoice_date": a["date"], "due_date": a["due_date"] or a["date"], "period_start": day(a["starts_at"]), "period_end": day(a["stops_at"]),
               "amount_idr": round(a["grand_total_in_cents"] / 100), "amount_paid_idr": round((a["paid_in_cents"] or 0) / 100), "status": "ISSUED",
               "notes": f"Booqable order #{od[oid]['attributes']['number']} ({od[oid]['attributes']['status']})" if oid in od else "no order"}
        (open_invoices if row["legacy_booking_number"] else outside).append(row)

def write(name, rows, header):
    with open(os.path.join(out, name), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header); w.writeheader(); w.writerows(rows)
write("migration-customers.csv", customers, ["legacy_customer_number","customer_type","full_name","company_name","phone_e164","email","address_line","city","postal_code","ktp_number","npwp","nib","pph_withheld","notes"])
write("migration-rentals.csv", rentals, ["legacy_booking_number","legacy_contract_number","legacy_customer_number","unit_code","unit_type_slug","start_date","current_period_end","monthly_price_idr","deposit_held_idr","paid_through","status","signed_contract_pdf","notes"])
write("migration-open-invoices.csv", open_invoices, ["legacy_invoice_number","legacy_booking_number","invoice_date","due_date","period_start","period_end","amount_idr","amount_paid_idr","status","notes"])
write("REVIEW-draft-invoices.csv", drafts, ["legacy_invoice_number","legacy_booking_number","invoice_date","due_date","period_start","period_end","amount_idr","amount_paid_idr","status","notes"])
write("REVIEW-unpaid-invoices-on-ended-rentals.csv", outside, ["legacy_invoice_number","legacy_booking_number","invoice_date","due_date","period_start","period_end","amount_idr","amount_paid_idr","status","notes"])

# Units: the 172 typed STORAGE units + the X-Large and Freestyle stock items Booqable has.
units = list(csv.DictReader(open(units_typed)))
latest_type = {r["unit_code"]: r["unit_type_slug"] for r in rentals}
for s in sorted(si.values(), key=lambda s: s["attributes"]["identifier"]):
    ident = s["attributes"]["identifier"]
    if s["attributes"]["archived"] or ident.startswith("STORAGE-"): continue
    n = ident.rsplit("-", 1)[1]
    kind = "XL" if ident.startswith("X_LARGE") else "FS"
    units.append({"unit_number": n, "unit_code": ident, "zone": kind, "unit_type_slug": latest_type.get(ident) or ("x-large-storage" if kind == "XL" else "free-style-1"),
                  "notes": "Booqable stock item; zone is a placeholder (not on the floor plan)" + ("" if ident in latest_type else "; Free Style band unknown (never rented) - defaulted to free-style-1" if kind == "FS" else "")})
with open(os.path.join(out, "units-full.csv"), "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["unit_number","unit_code","zone","unit_type_slug","notes"]); w.writeheader(); w.writerows(units)

mx = lambda kind: max((x["attributes"]["number"] or 0) for x in docs if x["attributes"]["document_type"] == kind)
print(f"customers with an active rental: {len(customers)}")
print(f"active unit rentals: {len(rentals)}  (by type: {dict(collections.Counter(r['unit_type_slug'] for r in rentals))})")
print(f"open invoices on active rentals: {len(open_invoices)}  total Rp {sum(r['amount_idr']-r['amount_paid_idr'] for r in open_invoices):,}")
print(f"draft (unfinalized) unpaid invoices, not imported: {len(drafts)}")
print(f"unpaid invoices on ENDED rentals (for review, not imported): {len(outside)}  total Rp {sum(r['amount_idr']-r['amount_paid_idr'] for r in outside):,}")
print(f"monthly rent: Rp {sum(r['monthly_price_idr'] for r in rentals):,}   deposits held: Rp {sum(r['deposit_held_idr'] for r in rentals):,}")
print(f"units file: {len(units)} ({len(units)-172} X-Large/Freestyle added)")
print(f"max legacy numbers: contract {mx('contract')}, invoice {mx('invoice')}")
print("notes:", dict(notes))
