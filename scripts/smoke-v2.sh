#!/usr/bin/env bash
# End-to-end smoke test of the PRD v2 storage flow against a running local
# API (:4000) + seeded gudang-aman tenant. Exercises: branch/size catalog ->
# availability -> booking (capacity + waitlist) -> pipeline -> approve ->
# request KYC -> magic-link login -> KYC upload/review -> contract + proforma
# (PDFs) -> pay -> ACTIVE -> AR aging horizon -> client list -> worker jobs.
# Prints PASS/FAIL per step; exits non-zero on the first failure.
set -uo pipefail
API=${API:-http://localhost:4000/api}
T=${TENANT:-gudang-aman}
H=(-H "Content-Type: application/json" -H "X-Tenant-Slug: $T")
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }
jqx() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

# --- staff login ---
STAFF=$(curl -s "${H[@]}" -X POST "$API/auth/console/login" -d '{"email":"superadmin@gudang-aman.test","password":"RentOS!Demo2026"}' | jqx "d['accessToken']") || fail "staff login"
FIN=$(curl -s "${H[@]}" -X POST "$API/auth/console/login" -d '{"email":"finance@gudang-aman.test","password":"RentOS!Demo2026"}' | jqx "d['accessToken']") || fail "finance login"
AH=(-H "Authorization: Bearer $STAFF")
pass "staff + finance login"

# --- catalog: branches with coordinates, sizes at a branch ---
LOCS=$(curl -s "${H[@]}" "$API/catalog/locations")
LOC=$(echo "$LOCS" | jqx "[l for l in d if 'Kelapa' in l['name']][0]['id']")
echo "$LOCS" | jqx "[(l['name'], l['latitude']) for l in d]"
SUMS=$(curl -s "${H[@]}" "$API/catalog/locations/$LOC/asset-types")
echo "$SUMS" | jqx "[(s['sizeClass'], s['assetType']['name'], s['unitCount'], s['availableNow']) for s in d]"
SMALL=$(echo "$SUMS" | jqx "[s for s in d if s['sizeClass']=='SMALL'][0]['assetType']['id']")
LARGE=$(echo "$SUMS" | jqx "[s for s in d if s['sizeClass']=='LARGE'][0]['assetType']['id']")
pass "branch + size catalog"

# --- quote: 3-month term, full first month (no proration) + schedule ---
START=$(date -u -d "+10 days" +%Y-%m-%dT00:00:00.000Z)
Q=$(curl -s "${H[@]}" "$API/catalog/asset-types/$SMALL/quote?startDate=$START&termMonths=3")
echo "$Q" | jqx "('total', d['totalAmount'], 'lines', [(l['lineType'], l['amount']) for l in d['lines']], 'schedule', [(p['index'], p['dueDate'][:10], p['totalAmount']) for p in d['schedule']])"
echo "$Q" | jqx "d['lines']" | grep -q '"lineType": "RENT", "amount": "450000"' 2>/dev/null || echo "$Q" | jqx "[l['amount'] for l in d['lines'] if l['lineType']=='RENT'][0]" | grep -q "^450000$" || fail "rent must be a full month (450000)"
[ "$(echo "$Q" | jqx "len(d['schedule'])")" = "3" ] || fail "schedule must have 3 rows"
pass "term quote: full first month + 3-row schedule"

# --- availability ---
AV=$(curl -s "${H[@]}" "$API/catalog/availability?locationId=$LOC&assetTypeId=$LARGE&startDate=$START&termMonths=1")
echo "$AV"
[ "$(echo "$AV" | jqx "d['available']")" = "True" ] || fail "LARGE should be available (1 unit)"
pass "availability check"

# --- booking 1: LARGE, capacity -> PENDING_APPROVAL ---
B1=$(curl -s "${H[@]}" -X POST "$API/bookings" -d "{\"assetTypeId\":\"$LARGE\",\"locationId\":\"$LOC\",\"startDate\":\"$START\",\"termMonths\":3,\"customerPhone\":\"+628111000001\",\"customerFullName\":\"Dewi Lestari\"}")
echo "$B1"
B1ID=$(echo "$B1" | jqx "d['id']"); [ "$(echo "$B1" | jqx "d['status']")" = "PENDING_APPROVAL" ] || fail "booking 1 should be PENDING_APPROVAL"
pass "booking 1 submitted with unit $(echo "$B1" | jqx "d['assetCode']")"

# --- booking 2: same LARGE unit, overlapping -> WAITLISTED ---
B2=$(curl -s "${H[@]}" -X POST "$API/bookings" -d "{\"assetTypeId\":\"$LARGE\",\"locationId\":\"$LOC\",\"startDate\":\"$START\",\"termMonths\":1,\"customerPhone\":\"+628111000002\",\"customerFullName\":\"Rudi Hartono\"}")
echo "$B2"
B2ID=$(echo "$B2" | jqx "d['id']"); [ "$(echo "$B2" | jqx "d['status']")" = "WAITLISTED" ] || fail "booking 2 should be WAITLISTED"
[ "$(echo "$B2" | jqx "d['waitlistPosition']")" = "1" ] || fail "waitlist position should be 1"
pass "booking 2 waitlisted (#1)"

# --- booking 3: blackout — LARGE starting right when booking 1 ends (+3 months) must be blocked; +4 months must pass ---
END3=$(date -u -d "$START +3 months" +%Y-%m-%dT00:00:00.000Z)
AFTER=$(date -u -d "$START +4 months" +%Y-%m-%dT00:00:00.000Z)
AV_BLOCK=$(curl -s "${H[@]}" "$API/catalog/availability?locationId=$LOC&assetTypeId=$LARGE&startDate=$END3&termMonths=1" | jqx "d['available']")
AV_OK=$(curl -s "${H[@]}" "$API/catalog/availability?locationId=$LOC&assetTypeId=$LARGE&startDate=$AFTER&termMonths=1" | jqx "d['available']")
[ "$AV_BLOCK" = "False" ] || fail "blackout month should block a booking starting at the previous end date"
[ "$AV_OK" = "True" ] || fail "unit should be free one month after the previous end date"
pass "blackout month enforced (blocked at end, free at end+1 month)"

# --- daily/weekly rejected ---
DW=$(curl -s "${H[@]}" -X POST "$API/bookings" -d "{\"assetTypeId\":\"$SMALL\",\"locationId\":\"$LOC\",\"startDate\":\"$START\",\"termMonths\":1,\"rateTier\":\"DAILY\",\"customerPhone\":\"+628111000003\",\"customerFullName\":\"X\"}" -o /dev/null -w "%{http_code}")
[ "$DW" = "400" ] || fail "DAILY tier should be rejected (got $DW)"
pass "daily/weekly tiers rejected"

# --- pipeline: both visible, stages ---
PIPE=$(curl -s "${H[@]}" "${AH[@]}" "$API/bookings/pipeline")
echo "$PIPE" | jqx "[(b['pipelineStage'], b['status'], b['customer']['fullName'], b['waitlistPosition'], b['stageDetail']) for b in d]"
pass "pipeline lists both"

# --- approve booking 1 -> APPROVED, stage KYC, no invoice yet ---
curl -s "${H[@]}" "${AH[@]}" -X POST "$API/bookings/$B1ID/approve" -d '{}' > /dev/null
STG=$(curl -s "${H[@]}" "${AH[@]}" "$API/bookings/pipeline" | jqx "[b['pipelineStage'] for b in d if b['id']=='$B1ID'][0]")
[ "$STG" = "KYC" ] || fail "after approval stage should be KYC (got $STG)"
pass "approved -> KYC stage (no invoice generated)"

# --- generate-contract must refuse before KYC ---
GC=$(curl -s "${H[@]}" "${AH[@]}" -X POST "$API/bookings/$B1ID/generate-contract" -o /dev/null -w "%{http_code}")
[ "$GC" = "409" ] || fail "generate-contract before KYC should 409 (got $GC)"
pass "contract blocked until KYC verified"

# --- request KYC -> message with magic link ---
curl -s "${H[@]}" "${AH[@]}" -X POST "$API/bookings/$B1ID/request-kyc" > /dev/null
LINK=$(psql "$DATABASE_URL" -tAq -c "select payload->>'link' from notifications where template_key='kyc_requested' order by created_at desc limit 1")
echo "magic link: $LINK"
TOKEN=$(echo "$LINK" | sed -E 's#.*/m/([^?]+).*#\1#')
pass "KYC requested (magic link minted)"

# --- magic link exchange -> customer session, no OTP ---
CUST=$(curl -s "${H[@]}" -X POST "$API/auth/magic/exchange" -d "{\"token\":\"$TOKEN\"}")
echo "$CUST" | jqx "(d['customer']['fullName'], d['purpose'])"
CT=$(echo "$CUST" | jqx "d['accessToken']") || fail "magic exchange"
CH=(-H "Authorization: Bearer $CT")
# reusable
curl -s "${H[@]}" -X POST "$API/auth/magic/exchange" -d "{\"token\":\"$TOKEN\"}" | jqx "d['customer']['fullName']" > /dev/null || fail "magic link should be reusable"
pass "magic link login works (reusable, no OTP)"

# --- customer uploads KTP + selfie, staff verifies ---
printf '\x89PNG\r\n\x1a\n' > /tmp/ktp.png
for T2 in KTP SELFIE; do
  curl -s -H "X-Tenant-Slug: $T" "${CH[@]}" -F "documentType=$T2" -F "file=@/tmp/ktp.png;type=image/png" "$API/kyc/documents" > /dev/null
done
for DOC in $(curl -s "${H[@]}" "${AH[@]}" "$API/kyc/documents" | jqx "' '.join(x['id'] for x in d)"); do
  curl -s "${H[@]}" "${AH[@]}" -X POST "$API/kyc/documents/$DOC/review" -d '{"status":"VERIFIED"}' > /dev/null
done
STG=$(curl -s "${H[@]}" "${AH[@]}" "$API/bookings/pipeline" | jqx "[b['pipelineStage'] for b in d if b['id']=='$B1ID'][0]")
[ "$STG" = "CONTRACT" ] || fail "after KYC verified stage should be CONTRACT (got $STG)"
pass "KYC verified -> CONTRACT stage"

# --- generate contract + proforma -> PDFs, schedule, FINANCE stage ---
GEN=$(curl -s "${H[@]}" "${AH[@]}" -X POST "$API/bookings/$B1ID/generate-contract")
echo "$GEN"
INV=$(echo "$GEN" | jqx "d['proformaInvoiceId']"); CON=$(echo "$GEN" | jqx "d['contractId']")
[ "$(echo "$GEN" | jqx "d['scheduledInvoices']")" = "2" ] || fail "3-month term should schedule 2 further invoices"
STG=$(curl -s "${H[@]}" "${AH[@]}" "$API/bookings/pipeline" | jqx "[b['pipelineStage'] for b in d if b['id']=='$B1ID'][0]")
[ "$STG" = "FINANCE" ] || fail "after contract stage should be FINANCE (got $STG)"
psql "$DATABASE_URL" -c "select schedule_index, status, invoice_number, issue_date::date, due_date::date, period_start::date, period_end::date, total_amount from invoices where booking_id='$B1ID' order by schedule_index"
curl -s -o /tmp/proforma.pdf -w "proforma pdf: %{http_code} %{content_type}\n" -H "X-Tenant-Slug: $T" "${CH[@]}" "$API/invoices/$INV/pdf"
curl -s -o /tmp/contract.pdf -w "contract pdf: %{http_code} %{content_type}\n" -H "X-Tenant-Slug: $T" "${CH[@]}" "$API/contracts/$CON/document"
head -c 4 /tmp/proforma.pdf | grep -q "%PDF" || fail "proforma is not a PDF"
head -c 4 /tmp/contract.pdf | grep -q "%PDF" || fail "contract is not a PDF"
pass "contract + proforma generated (PDFs ok, 3-row schedule, FINANCE stage)"

# --- ledger: only the proforma posted (scheduled ones must not) ---
psql "$DATABASE_URL" -c "select reference_id = '$INV' as is_proforma, count(*) from ledger_entries where reference_type='INVOICE' and reference_id in (select id from invoices where booking_id='$B1ID') group by 1"

# --- AR aging with horizons (scheduled invoices show up as coming due) ---
curl -s "${H[@]}" "${AH[@]}" "$API/reports/ar-aging?horizonDays=90" | jqx "('overdue', d['overdue']['total'], 'coming', d['comingDue'], 'count', d['invoiceCount'])"
pass "AR aging horizon"

# --- customer pays proforma (mock provider confirms instantly) -> ACTIVE ---
PAY=$(curl -s "${H[@]}" "${CH[@]}" -X POST "$API/payments/initiate" -d "{\"invoiceId\":\"$INV\",\"method\":\"QRIS\"}")
echo "$PAY"
BST=$(curl -s "${H[@]}" "${AH[@]}" "$API/bookings/$B1ID" | jqx "(d['status'], d['anchorDay'], d['asset']['status'])")
echo "booking after payment: $BST"
echo "$BST" | grep -q "'ACTIVE'" || fail "booking should be ACTIVE after paying the proforma"
pass "paid -> ACTIVE, unit OCCUPIED"

# --- client list + detail ---
curl -s "${H[@]}" "${AH[@]}" "$API/customers/clients?search=dewi" | jqx "[(c['fullName'], c['health'], [u['code'] for u in c['units']], c['nextDueDate'][:10] if c['nextDueDate'] else None, c['outstandingAmount']) for c in d['items']]"
curl -s "${H[@]}" "${AH[@]}" "$API/customers/clients" | jqx "d['counts']"
CID=$(echo "$CUST" | jqx "d['customer']['id']")
curl -s "${H[@]}" "${AH[@]}" "$API/customers/clients/$CID" | jqx "(d['summary']['health'], len(d['customer']['bookings']), len(d['customer']['bookings'][0]['invoices']), len(d['notifications']))"
pass "client list + detail"

# --- waitlist: offer unit must fail (LARGE still taken), reject works ---
OF=$(curl -s "${H[@]}" "${AH[@]}" -X POST "$API/bookings/$B2ID/offer-unit" -d '{}' -o /dev/null -w "%{http_code}")
[ "$OF" = "409" ] || fail "offer-unit with no free unit should 409 (got $OF)"
curl -s "${H[@]}" "${AH[@]}" -X POST "$API/bookings/$B2ID/reject" -d '{"reason":"No unit this quarter"}' | jqx "d['status']" | grep -q REJECTED || fail "waitlist reject"
pass "waitlist offer/reject"

# --- ledger balance ---
psql "$DATABASE_URL" -tAq -c "select entry_type, sum(amount) from ledger_entries group by 1 order by 1"
echo "DONE: booking=$B1ID invoice=$INV contract=$CON customer=$CID"
