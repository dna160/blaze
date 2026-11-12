"""Download a Booqable account through its API (v4) into JSON files, one per resource.

    BOOQABLE_API_KEY=... python3 scripts/booqable/fetch.py <out-dir> [account-slug]

The key is read from the environment and never written anywhere. The output
holds customer PII: keep it out of the repository.
"""
import json, sys, time, urllib.request, os
out = sys.argv[1]
slug = sys.argv[2] if len(sys.argv) > 2 else "city-storage-kebon-jeruk"
K = os.environ.get("BOOQABLE_API_KEY") or sys.exit("Set BOOQABLE_API_KEY.")
os.makedirs(out, exist_ok=True)
B = f"https://{slug}.booqable.com/api/4"
def get(url):
    for i in range(4):
        try:
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {K}", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:
            if i == 3: raise
            time.sleep(2 ** i)
RESOURCES = [
    "customers", "orders", "product_groups", "products", "stock_items", "documents", "payments", "lines", "plannings",
    "stock_item_plannings", "properties", "default_properties",
    # Added for the completeness audit (2026-11-12): everything else the account holds.
    "notes", "emails", "email_templates", "bundles", "bundle_items", "coupons", "tax_rates", "tax_regions", "tax_values",
    "locations", "employees", "price_structures", "price_tiles", "operating_rules", "photos", "collections", "items",
]
for res in RESOURCES:
    rows, page = [], 1
    while True:
        try:
            d = get(f"{B}/{res}?page%5Bsize%5D=100&page%5Bnumber%5D={page}")
        except Exception as e:
            print(res, "ERROR", e); break
        data = d.get("data", [])
        rows += data
        if len(data) < 100: break
        page += 1
    json.dump(rows, open(os.path.join(out, f"{res}.json"), "w"))
    print(f"{res:22} {len(rows)}")

# Files behind short-lived links: contract signature images (pre-signed S3 URLs
# that expire within minutes) and product photos. Saved next to the JSON so the
# archive can embed them — the links die with the Booqable account.
def download(url, path):
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            open(path, "wb").write(r.read())
        return True
    except Exception:
        return False

os.makedirs(os.path.join(out, "signatures"), exist_ok=True)
os.makedirs(os.path.join(out, "photos"), exist_ok=True)
docs = json.load(open(os.path.join(out, "documents.json")))
signed = [d for d in docs if d["attributes"].get("signature_url")]
ok = 0
for d in signed:
    path = os.path.join(out, "signatures", d["id"])
    if os.path.exists(path) and os.path.getsize(path) > 0:
        ok += 1
        continue
    url = d["attributes"]["signature_url"]
    if not download(url, path):
        # The link expired while paging; ask for a fresh one.
        try:
            url = get(f"{B}/documents/{d['id']}")["data"]["attributes"].get("signature_url")
        except Exception:
            url = None
        if not (url and download(url, path)):
            continue
    ok += 1
print(f"{'signatures':22} {ok} of {len(signed)}")
photos = json.load(open(os.path.join(out, "photos.json"))) if os.path.exists(os.path.join(out, "photos.json")) else []
print(f"{'photos':22} {sum(1 for p in photos if download(p['attributes'].get('large_url') or p['attributes'].get('original_url'), os.path.join(out, 'photos', p['id'])))} of {len(photos)}")

