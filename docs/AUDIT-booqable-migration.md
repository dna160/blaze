# Audit — is everything in Booqable now in RentOS? (2026-11-12)

**Answer: no.** RentOS holds the *live book* (who rents what today, and what
they owe). It does not hold Booqable's *history* (ended rentals, paid invoices,
payments), and three parts of the live book are incomplete or stale.

Method: a fresh full pull of the Booqable account through its API
(`scripts/booqable/fetch.py`, 29 record types) compared with the live City
Storage Kebon Jeruk branch through the RentOS API. Counts only; no customer
data is stored in this file.

## Record by record

| Booqable | Count | In RentOS | Gap |
|---|---|---|---|
| Customers | 99 | 86 | 13 missing: 9 past customers (only ended rentals), 4 test/empty records. All fields of the 86 carried over (phone, email, address, NPWP, NIK/NIB, PIC). |
| Units (stock items) | 198 live | 196 | STORAGE-103, STORAGE-105 (never rented, size unknown). 186 archived Booqable duplicates correctly ignored. |
| Orders — active (started/reserved) | 170 | 188 unit rentals | Covered as of 2026-11-10. **Stale since:** 1 new order (#389) and 4 edited orders. |
| Orders — ended (stopped) | 189 | 0 | Rental history not imported (Rp 740 million of past rentals). |
| Orders — canceled | 30 | 0 | Not imported. |
| Invoices — unpaid | 58 (Rp 332.5 million) | 48 (Rp 258.7 million) | 6 on ended rentals (Rp 39.7 million), 3 unfinalized drafts, 1 new since the import. One imported invoice is Rp 1.1 million short: its unpaid deposit was left off. |
| Invoices — paid | 314 (Rp 2.38 billion) | 0 | Not imported. |
| Payments | 316 (Rp 2.45 billion; 311 charges, 5 refunds; all manual bank) | 0 | Not imported. |
| Deposits held | Rp 52.67 million net, 38 active customers hold Rp 49.59 million | Rp 16.22 million on 17 rentals | **Rp 33.4 million under-recorded.** The importer read deposits from the current order only; most were paid on an earlier, ended order of the same customer. Rp 3.08 million is held for customers with no active rental. |
| Contracts | 203 (139 signed, 138 with a signature image) | 188 contract rows, numbers kept | No PDF or signature attached. Booqable's API does not serve PDFs; it does give the contract text (HTML) and the signature image, which downloads fine. |
| Order notes | 48, on 23 customers | 0 | 13 customers' notes record PPh withholding ("Pot PPh 10% = …"); none of the 86 customers has `pphWithheld` set. Others record over/under-payments and split payments. |
| Extra charges on active orders | 12 lines (padlock, manpower, management fee, late fine) | folded into the invoice total | Line detail lost on the 48 open invoices (one RENT line each). |
| Emails sent | 6 | 0 | Not imported (low value). |

## Configuration (not customer data)

| Booqable | Count | RentOS |
|---|---|---|
| Products / bundles | 3 products, 6 bundles (Small/Medium/Large + three "1 Year Promo") | 7 unit types from the quotation. The 1-year promos have no equivalent (promo logic is out of scope in the PRD). |
| Coupons | 3 (one per 1-year promo) | none |
| Price structures / tiles | 7 / 30 | flat monthly price per type; each rental keeps its own actual price |
| Tax rates | 3 ("PPh Sewa" ×2, "Non PKP"); every invoice carries Rp 0 tax | branch is non-PKP, matches |
| Employees | 5, all with email | 1 real account; the Booqable list answers the staff-list blocker |
| Email templates | 16 | RentOS has its own WhatsApp/email templates |
| Photos | 7 | none on unit types |
| Locations | 1 | 1 |

## What a complete migration still needs

1. **Re-sync the live book** just before cut-over (idempotent): picks up order
   #389 and the 4 edits.
2. **Fix deposits**: take each customer's deposits from Booqable *payments*
   (charges − refunds) across all their orders, not the current order.
3. **Import the history**: the 13 remaining customers, 189 ended + 30 canceled
   rentals, 314 paid invoices and 316 payments, as read-only history that posts
   nothing to the ledger (RentOS's books start at the opening balances).
4. **Attach contracts**: regenerate each Booqable contract in RentOS with its
   stored text and signature image (or upload scans), so the document vault has
   them.
5. **Carry the notes**: PPh withholding → `pphWithheld`; the rest onto the
   client record.
6. **Decide**: the 6 unpaid invoices on ended rentals, the 3 drafts, the 5
   units with two active tenants, STORAGE-103/105.

Until 1–2 are done, RentOS's deposits and one invoice are wrong; until 3–5 are
done, Booqable must be kept (read-only) as the record of the past.
