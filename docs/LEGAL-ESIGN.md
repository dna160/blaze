# RentOS — E-Signature Cost & Legal Architecture

**Precedence:** authoritative for the e-signature model. Restates and expands
`docs/BUILD-SPEC.md` §5. Ties to blocking decisions **B3** and **B9** (§7 of the
spec) and delta-register items **#22, #23, #24, #25**.

Status: **specification + open legal question.** No certified-signature provider is
configured in the codebase today — the `ESignProvider` port exists, the Privy
adapter is coded but unconfigured, and `MockESignProvider` is the default (see
`docs/HANDOFF.md`, Session 11). **Build behind the mock until B3 is answered.**

---

## 1. The cost problem, stated plainly

City Storage issues a new contract **every month, per customer**. Certified
e-signatures (PSrE) are priced per signature.

- 100 occupied units → ~1,200 certified signatures / year.
- Cost scales linearly with occupancy **and** with every new franchise branch.
- A naive "one certified signature per monthly contract" design is a recurring cost
  that *grows with the client's success* and gets billed back monthly — the worst
  possible number to hand a client in month three.

## 2. The structure to build instead

Split the enforceable terms (signed once) from the monthly commitment (accepted
cheaply, but with real evidentiary weight).

```
Onboarding (ONCE per customer)
  └── Master Rental Agreement
        · certified PSrE signature
        · e-Meterai affixed if document value > Rp 5,000,000
        · contains ALL enforceable terms

Every month (per rental period)
  └── Rental Order  →  references the master agreement
        · WhatsApp OTP acceptance, or one-tap click-to-accept
        · logged: timestamp, IP, device, OTP proof
        · NO certified signature consumed
```

Expected effect: **~90% reduction** in certified-signature spend versus the naive
per-order approach.

## 3. Legal basis (to be confirmed by counsel — B3)

`UU ITE` Article 11 requires that signature-creation data relate only to the
signatory and remain under their sole control during signing. The argument this
architecture rests on:

- The **master agreement** carries the enforceable terms and is signed with a
  certified signature — full legal weight, unambiguous.
- Each **monthly order** is an acceptance made *against an identity already
  certified* under that master, captured with an OTP the signatory solely controls,
  plus a tamper-evident evidence record (timestamp, IP, device, OTP proof). This
  carries real evidentiary weight for the *order-level* commitment.

**This reasoning must be lawyer-confirmed before build (B3).** If the client's B2B
counterparties reject order-level OTP acceptance, the fallback is a certified
signature per order — at which point the running-cost line item must be repriced and
re-communicated. **Do not discover this in month two.**

## 4. Provider strategy

| Role | Provider | Why |
|---|---|---|
| Primary | **Mekari Sign** | API-first, e-Meterai API available, signers need no account, sandbox available |
| Fallback | **Privy** | larger installed base — many B2B counterparties already hold a Privy ID and sign in one tap; adapter already coded (unconfigured) |
| Default until keys land | **MockESignProvider** | zero-regression default; ship this until B3 clears and sandbox keys arrive |

Because the repo already has the `ESignProvider` port, adding Mekari Sign is an
**adapter swap, not a refactor** (`apps/api/src/agreements/providers/`).

## 5. e-Meterai (B9)

- Affix e-Meterai on documents whose value exceeds **Rp 5,000,000** (#25).
- Applies to the **master agreement** in the model above (the high-value,
  enforceable document), not to each monthly order.
- **Confirm the client's current practice first (B9):** whether they affix e-Meterai
  on contracts today drives whether this is in-scope for launch or a fast-follow.

## 6. Acceptance evidence record (R2 gate requirement)

Each order-level acceptance must persist an exportable evidence bundle containing at
minimum:

- Master-agreement reference (which certified contract this order is bound to)
- Timestamp (server-authoritative)
- IP address
- Device / user-agent
- OTP proof (challenge id + verification record, not the OTP value itself)

Gate R2 requires: master agreement signed once via Mekari sandbox, three subsequent
monthly orders accepted by OTP with **zero** additional certified signatures
consumed, and the acceptance record exportable as an evidence bundle.

---

## 7. Lawyer sign-off record (B3)

Fill this in when counsel responds. Until `Decision` reads **APPROVED**, the build
stays on `MockESignProvider` and no certified-signature provider is wired to
production.

| Field | Value |
|---|---|
| Question (B3) | Will B2B counterparties accept order-level OTP acceptance under a signed master agreement? |
| Counsel (name / firm) | Client-side (relayed via client, 2026-08-09) |
| Date answered | 2026-08-09 |
| Decision | **APPROVED** — order-level OTP acceptance under a signed master is acceptable |
| Conditions (if any) | None recorded. B9: **no e-Meterai** — signature only. |
| If REJECTED — repriced running-cost line item | n/a (approved) |
| Recorded by | Session 20 (this remediation session) |

> Consequence for the build: the §2 structure (master signed once + per-order OTP
> acceptance) stands. e-Meterai is **out of scope** (B9). The `OrderAcceptance`
> model (schema, landed R0/R1) records the evidence bundle; the Mekari Sign adapter
> behind the existing `ESignProvider` port is the R2 task, with `MockESignProvider`
> as the default until sandbox keys land.

**On REJECTED:** switch the order path to certified-signature-per-order, update the
commercial quotation's running-cost line, and record the change in `docs/HANDOFF.md`
before proceeding with R2.
