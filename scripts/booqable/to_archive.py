"""Booqable export (JSON from fetch.py) -> legacy-archive batches for RentOS.

    python3 scripts/booqable/to_archive.py <fetch-dir> <out-dir>

Everything the account holds, kept as Booqable made it (owner, 2026-11-12:
"work with what is already made and save it as a backlog"): customers, every
order with its lines, units and notes, every invoice/contract/quote with its
lines, every payment and refund, the contract text and the customer's
signature image, emails, and the account's configuration.

Writes <out-dir>/archive-NNN.json, each {"source": "booqable", "records": [...]}
and under ~1.5 MB, for POST /api/legacy/records/import. Signature images and
product photos are embedded from the files fetch.py saved (their Booqable/S3
links expire within minutes, and for good when the account is closed).

The output holds customer PII: keep it out of the repository.
"""
import base64, collections, hashlib, json, os, sys

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
L = lambda n: json.load(open(f"{src}/{n}.json")) if os.path.exists(f"{src}/{n}.json") else []

SECRET_KEYS = ("secret", "stripe", "provider_link", "redirect_url", "password", "token")


def clean(attrs):
    """Attributes as exported, minus credentials/links that are not data."""
    return {k: v for k, v in attrs.items() if not any(s in k for s in SECRET_KEYS)}


def local_data_url(folder, name, max_bytes=900_000):
    """A file fetch.py saved, as a data: URL (type sniffed from its first bytes)."""
    path = os.path.join(src, folder, name)
    if not os.path.exists(path):
        return None
    body = open(path, "rb").read()
    if not body or len(body) > max_bytes:
        return None
    ctype = "image/png" if body[:4] == b"\x89PNG" else "image/jpeg" if body[:2] == b"\xff\xd8" else "image/webp" if body[8:12] == b"WEBP" else "image/svg+xml" if b"<svg" in body[:300] else "application/octet-stream"
    return f"data:{ctype};base64,{base64.b64encode(body).decode()}"


cu = {c["id"]: c for c in L("customers")}
od = {o["id"]: o for o in L("orders")}
si = {s["id"]: s for s in L("stock_items")}
lines_by_owner = collections.defaultdict(list)
for l in L("lines"):
    a = l["attributes"]
    if a.get("archived"):
        continue
    lines_by_owner[a["owner_id"]].append(
        {k: a.get(k) for k in ["title", "line_type", "quantity", "price_each_in_cents", "price_in_cents", "charge_label", "extra_information", "position"]}
    )
for v in lines_by_owner.values():
    v.sort(key=lambda x: x.get("position") or 0)
units_by_order = collections.defaultdict(list)
for s in L("stock_item_plannings"):
    a = s["attributes"]
    it = si.get(a["stock_item_id"])
    if it:
        units_by_order[a["order_id"]].append({"unit": it["attributes"]["identifier"], "starts_at": a.get("starts_at"), "stops_at": a.get("stops_at"), "status": a.get("status")})
notes_by_order = collections.defaultdict(list)
for n in L("notes"):
    notes_by_order[n["attributes"].get("owner_id")].append({"body": n["attributes"].get("body"), "created_at": n["attributes"].get("created_at")})


def cust(cid):
    c = cu.get(cid)
    return (c["attributes"]["number"], (c["attributes"].get("name") or "").strip()) if c else (None, None)


def idr(cents):
    return None if cents is None else round(cents / 100, 2)


records = []


def add(kind, legacy_id, **kw):
    records.append({"kind": kind, "legacyId": str(legacy_id), **{k: v for k, v in kw.items() if v is not None}})


for c in cu.values():
    a = c["attributes"]
    add("CUSTOMER", c["id"], number=str(a["number"]), customerNumber=a["number"], customerName=(a.get("name") or "").strip(), occurredAt=a.get("created_at"),
        status="archived" if a.get("archived") else a.get("legal_type"), title=(a.get("name") or "").strip(), data=clean(a))

for o in od.values():
    a = o["attributes"]
    num, name = cust(a.get("customer_id"))
    units = units_by_order.get(o["id"], [])
    add("ORDER", o["id"], number=str(a["number"]), customerNumber=num, customerName=name, occurredAt=a.get("starts_at") or a.get("created_at"),
        amount=idr(a.get("grand_total_with_tax_in_cents")), status=a.get("status"),
        title=f"Order #{a['number']}" + (" · " + ", ".join(sorted({u['unit'] for u in units})) if units else ""),
        data={**clean(a), "lines": lines_by_owner.get(o["id"], []), "units": units, "notes": notes_by_order.get(o["id"], [])})

texts = {}


def text_ref(html):
    if not html:
        return None
    h = hashlib.sha256(html.encode()).hexdigest()
    texts[h] = html
    return h


KIND = {"invoice": "INVOICE", "contract": "CONTRACT", "quote": "QUOTE"}
sig_ok = sig_fail = 0
for d in L("documents"):
    a = d["attributes"]
    kind = KIND.get(a["document_type"], "DOCUMENT")
    num, name = cust(a.get("customer_id"))
    order = od.get(a.get("order_id"))
    data = {k: v for k, v in clean(a).items() if k not in ("body", "footer", "signature_url")}
    data["lines"] = lines_by_owner.get(d["id"], [])
    data["orderNumber"] = order["attributes"]["number"] if order else None
    data["units"] = sorted({u["unit"] for u in units_by_order.get(a.get("order_id"), [])})
    data["bodyRef"] = text_ref(a.get("body"))
    data["footerRef"] = text_ref(a.get("footer"))
    if a.get("signature_url"):
        img = local_data_url("signatures", d["id"])
        if img:
            data["signatureImage"] = img
            sig_ok += 1
        else:
            sig_fail += 1
    status = a.get("status") or ""
    if kind == "CONTRACT" and a.get("signed"):
        status = f"{status}, signed"
    number = a.get("prefix_with_number") or (str(a["number"]) if a.get("number") else None)
    add(kind, d["id"], number=number, customerNumber=num, customerName=name or (a.get("name") or "").strip() or None,
        occurredAt=(a.get("date") + "T00:00:00.000Z") if a.get("date") else a.get("created_at"),
        amount=idr(a.get("grand_total_with_tax_in_cents")), status=status,
        title=f"{kind.title()} #{number or '(draft)'}", data=data)

for p in L("payments"):
    a = p["attributes"]
    num, name = cust(a.get("customer_id"))
    order = od.get(a.get("order_id"))
    if num is None and order:  # some refunds carry only their order
        num, name = cust(order["attributes"].get("customer_id"))
    refund = a.get("type") == "payment_refunds"
    add("PAYMENT", p["id"], number=str(order["attributes"]["number"]) if order else None, customerNumber=num, customerName=name,
        occurredAt=a.get("succeeded_at") or a.get("created_at"), amount=idr((-1 if refund else 1) * (a.get("total_in_cents") or 0)), status=a.get("status"),
        title=("Refund" if refund else "Payment") + f" · {a.get('provider_method') or a.get('provider') or ''}" + (f" · order #{order['attributes']['number']}" if order else ""),
        data={**clean(a), "orderNumber": order["attributes"]["number"] if order else None})

for n in L("notes"):
    a = n["attributes"]
    order = od.get(a.get("owner_id"))
    num, name = cust(order["attributes"].get("customer_id")) if order else (None, None)
    add("NOTE", n["id"], number=str(order["attributes"]["number"]) if order else None, customerNumber=num, customerName=name, occurredAt=a.get("created_at"),
        title=(a.get("body") or "")[:200], data={**clean(a), "orderNumber": order["attributes"]["number"] if order else None})

for e in L("emails"):
    a = e["attributes"]
    num, name = cust(a.get("customer_id"))
    add("EMAIL", e["id"], customerNumber=num, customerName=name, occurredAt=a.get("created_at"), status="sent" if a.get("sent") else "not sent", title=a.get("subject"), data=clean(a))

for h, html in texts.items():
    add("TEXT", h, title="Contract/invoice text", data={"html": html})

photos = []
for p in L("photos"):
    a = clean(p["attributes"])
    img = local_data_url("photos", p["id"])
    photos.append({**a, **({"image": img} if img else {})})
CONFIG = {
    "products": L("product_groups") and [{"group": g["attributes"], "products": [p["attributes"] for p in L("products") if p["attributes"].get("product_group_id") == g["id"]]} for g in L("product_groups")],
    "bundles": [{**b["attributes"], "items": [i["attributes"] for i in L("bundle_items") if i["attributes"].get("bundle_id") == b["id"]]} for b in L("bundles")],
    "coupons": [c["attributes"] for c in L("coupons")],
    "tax": {"rates": [t["attributes"] for t in L("tax_rates")], "regions": [t["attributes"] for t in L("tax_regions")], "values": [t["attributes"] for t in L("tax_values")]},
    "pricing": {"structures": [{**s["attributes"], "id": s["id"]} for s in L("price_structures")], "tiles": [t["attributes"] for t in L("price_tiles")]},
    "employees": [clean(e["attributes"]) for e in L("employees")],
    "operating_rules": [r["attributes"] for r in L("operating_rules")],
    "email_templates": [t["attributes"] for t in L("email_templates")],
    "locations": [l["attributes"] for l in L("locations")],
    "default_properties": [p["attributes"] for p in L("default_properties")],
    "photos": photos,
    "units": [{k: s["attributes"].get(k) for k in ["identifier", "archived", "status", "created_at"]} for s in si.values()],
}
for key, value in CONFIG.items():
    if value:
        add("CONFIG", key, title=key.replace("_", " ").title(), status=f"{len(value)} item(s)" if isinstance(value, list) else None, data={"items": value} if isinstance(value, list) else value)

# Batches under ~1.5 MB of JSON each.
batch, size, n = [], 0, 0
def flush():
    global batch, size, n
    if not batch:
        return
    n += 1
    json.dump({"source": "booqable", "records": batch}, open(os.path.join(out, f"archive-{n:03d}.json"), "w"))
    batch, size = [], 0
for r in records:
    s = len(json.dumps(r))
    if size + s > 1_500_000:
        flush()
    batch.append(r)
    size += s
flush()

print("records:", dict(collections.Counter(r["kind"] for r in records)), "| total", len(records), "| batches", n)
print(f"signature images embedded: {sig_ok}" + (f", missing: {sig_fail}" if sig_fail else ""), "| photos embedded:", sum(1 for p in photos if p.get("image")), "of", len(photos))
