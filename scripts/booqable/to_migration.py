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
# Re-sync: the migration-rentals.csv that was applied last time. A rental's
# key is "<first active order>/<unit>", and that order changes when Booqable
# closes it and a renewal takes over — so a rental already in RentOS keeps the
# key (and contract number) it was imported under.
PREV = list(csv.DictReader(open(sys.argv[5]))) if len(sys.argv) > 5 else []
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

order_customer = {o["attributes"]["number"]: o["attributes"].get("customer_id") for o in od.values()}
prev_by = {}
for r in PREV:
    n = r["legacy_booking_number"].split("/")[0]
    if n.isdigit(): prev_by[(order_customer.get(int(n)), r["unit_code"])] = r
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
    kept = prev_by.get((cid, unit))
    if kept:
        booking, cnum = kept["legacy_booking_number"], kept["legacy_contract_number"]
        if booking.split("/")[0] != str(first["attributes"]["number"]): notes["rental kept under its earlier key (its first order has since closed)"] += 1
    used_contract[cnum] += 1
    # A free-month promo order has a Rp 0 line; the rent is the latest NON-zero price in the
    # chain, else the unit type's list price from the quotation.
    LIST = {"small-storage": 1100000, "medium-storage": 2100000, "large-storage": 4100000, "x-large-storage": 7200000,
            "free-style-1": 320000, "free-style-2": 610000, "free-style-3": 900000}
    nonzero = [pr for (_, _, pr) in items if pr]
    price = nonzero[-1] if nonzero else LIST.get(type_slug(items[-1][1], 0) or UNIT_TYPE.get(unit, "") or "", 0)
    if not nonzero: notes["rental priced from the list price (only Rp 0 promo orders)"] += 1
    deposit = 0  # filled below from Booqable's payment records
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
        "signed_contract_pdf": "", "notes": f"Booqable orders {status_note}",
    })

# Deposits (audit 2026-11-12): what is HELD is what the payment records say was
# paid as deposit minus what was refunded, per customer, across ALL their orders
# — most deposits were paid on an earlier, ended order than the current one.
# Each deposit payment goes to the customer's active rentals of the units on
# that payment's order; when none of those units is still rented, to the
# customer's first active rental. Split evenly, the remainder on the first.
payments = L("payments")
all_units_by_order = collections.defaultdict(list)
for s_ in sip:
    it = si.get(s_["attributes"]["stock_item_id"])
    if it: all_units_by_order[s_["attributes"]["order_id"]].append(it["attributes"]["identifier"])
rentals_by_cust = collections.defaultdict(list)
for r in rentals: rentals_by_cust[r["legacy_customer_number"]].append(r)
deposit_no_rental = collections.Counter()
for pmt in sorted(payments, key=lambda x: x["attributes"].get("succeeded_at") or x["attributes"]["created_at"]):
    a = pmt["attributes"]
    if a.get("status") != "succeeded" or not a.get("deposit_in_cents"): continue
    amt = round(a["deposit_in_cents"] / 100) * (1 if a["type"] == "payment_charges" else -1)
    # Some refunds carry no customer of their own, only the order they belong to.
    c = cu.get(a["customer_id"]) or cu.get((od.get(a.get("order_id")) or {}).get("attributes", {}).get("customer_id"))
    if not c: continue
    mine = rentals_by_cust.get(c["attributes"]["number"], [])
    if not mine:
        deposit_no_rental[c["attributes"]["number"]] += amt; continue
    on_order = set(all_units_by_order.get(a.get("order_id"), []))
    target = [r for r in mine if r["unit_code"] in on_order] or mine[:1]
    share, rem = divmod(abs(amt), len(target)); sign = 1 if amt > 0 else -1
    for i, r in enumerate(target): r["deposit_held_idr"] += sign * (share + (rem if i == 0 else 0))
for r in rentals:
    if r["deposit_held_idr"] < 0:  # a refund recorded against units the customer no longer rents
        notes["rental with a negative deposit after refunds (set to 0, review)"] += 1; r["deposit_held_idr"] = 0
    if r["deposit_held_idr"]: r["notes"] += f"; deposit Rp {r['deposit_held_idr']:,} per Booqable payments"

# Order notes: staff recorded PPh withholding and payment remarks on orders.
order_notes = collections.defaultdict(list)
for n in (L("notes") if os.path.exists(f"{d}/notes.json") else []):
    o = od.get(n["attributes"].get("owner_id")); body = (n["attributes"].get("body") or "").strip()
    if o and body and o["attributes"].get("customer_id") in cu:
        order_notes[cu[o["attributes"]["customer_id"]]["attributes"]["number"]].append(f"#{o['attributes']['number']}: {body}")
import re as _re
pph_customers = {num for num, ns in order_notes.items() if any(_re.search(r"\bpot\w*\s+pp", x, _re.I) for x in ns)}

active_customers = {r["legacy_customer_number"] for r in rentals}
with_orders = {cu[o["attributes"]["customer_id"]]["attributes"]["number"] for o in od.values() if o["attributes"].get("customer_id") in cu and o["attributes"]["status"] != "canceled"}
props = collections.defaultdict(dict)
for c in cu.values(): props[c["id"]] = c["attributes"].get("properties") or {}
customers = []
for c in sorted(cu.values(), key=lambda c: c["attributes"]["number"]):
    a = c["attributes"]
    # Everyone who ever rented: active customers, and past customers kept for
    # the record (their history is in the legacy archive). Empty test records stay out.
    if a["number"] not in active_customers and a["number"] not in with_orders: continue
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
        "pph_withheld": "true" if a["number"] in pph_customers else "",
        "notes": (f"Booqable customer #{a['number']}" + ("" if a["number"] in active_customers else " (past customer)") + (f"; PIC phone {p.get('pic_phone')}" if p.get("pic_phone") and business else "")
                  + ("; notes: " + " | ".join(order_notes[a["number"]]) if order_notes.get(a["number"]) else ""))[:900],
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
               # Booqable's own "to be paid" (it includes an unpaid deposit, which grand_total does not).
               "amount_idr": round((a["to_be_paid_in_cents"] + (a["paid_in_cents"] or 0)) / 100), "amount_paid_idr": round((a["paid_in_cents"] or 0) / 100), "status": "ISSUED",
               "notes": (f"Booqable order #{od[oid]['attributes']['number']} ({od[oid]['attributes']['status']})" if oid in od else "no order")
                        + (f"; includes unpaid deposit Rp {round((a.get('deposit_to_be_paid_in_cents') or 0) / 100):,}" if (a.get("deposit_to_be_paid_in_cents") or 0) > 0 else "")}
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
write("REVIEW-deposits-for-customers-without-active-rental.csv", [{"legacy_customer_number": k, "net_deposit_idr": v} for k, v in sorted(deposit_no_rental.items()) if v], ["legacy_customer_number", "net_deposit_idr"])
print(f"customers flagged as withholding PPh (from order notes): {len(pph_customers & {c['legacy_customer_number'] for c in customers})}")
print(f"past customers included: {sum(1 for c in customers if c['legacy_customer_number'] not in active_customers)}")
print(f"deposits for customers with no active rental (review, not imported): Rp {sum(v for v in deposit_no_rental.values()):,}")
print(f"units file: {len(units)} ({len(units)-172} X-Large/Freestyle added)")
print(f"max legacy numbers: contract {mx('contract')}, invoice {mx('invoice')}")
print("notes:", dict(notes))
