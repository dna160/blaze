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
for res in ["customers", "orders", "product_groups", "products", "stock_items", "documents", "payments", "lines", "plannings", "stock_item_plannings", "properties", "default_properties"]:
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
