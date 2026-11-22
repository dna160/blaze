/**
 * PRD go-live 2 §9.1 acceptance — no hard-coded UI text in the translated
 * console areas, and the two message files have the same keys.
 *
 *   node scripts/check-i18n.mjs            (fails with a list of literals)
 *   node scripts/check-i18n.mjs --summary  (counts per file)
 *
 * A "literal" is a JSX text node with letters in it, a `{"..."}` string
 * expression child, or a string literal in placeholder / title / aria-label /
 * alt / label. Those must come from `t("…")` (messages/<locale>.json). The
 * allowlist below covers brand names, units and codes that read the same in
 * every language.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");

/** The areas §9.1 names. Paths relative to src/. */
const CHECKED = [
  "components/ConsoleShell.tsx",
  "components/ConsoleBanners.tsx",
  "components/UserMenu.tsx",
  "components/ReportRange.tsx",
  "components/ClientList.tsx",
  "components/KycPanel.tsx",
  "components/ChangeRequests.tsx",
  "components/TestAllowlistPanel.tsx",
  "components/LinkedDevicePanel.tsx",
  "components/CsvImportPanel.tsx",
  "components/SignedScanUpload.tsx",
  "components/PasswordRules.tsx",
  "components/BrandMark.tsx",
  // P1 set (go-live 2 §7.2, §7.3, §10)
  "components/LegacyPaid.tsx",
  "components/CustomerMergeDialog.tsx",
  "components/RentalOrderStatus.tsx",
  "components/MoneyRulesPanel.tsx",
  "components/ArrearsBadge.tsx",
  "components/OvertimeCharge.tsx",
  "components/InvoiceSettlement.tsx",
  "app/rental-orders",
  "app/bukti-potong",
  "app/assets",
  "app/login",
  "app/set-password",
  "app/account",
  "app/reports",
  "app/deposits",
  "app/kyc",
  "app/bookings",
  "app/clients",
  "app/settings",
  "app/change-requests",
  "app/legacy",
  "app/invoices",
  "app/messaging",
];

const PROPS = new Set(["placeholder", "title", "aria-label", "alt", "label"]);

/** Text that is the same in every language: brands, units, codes, symbols. */
const ALLOW = [
  /^[✓✗\s\d.,:;!?·•—–\-+/%()[\]#&*×=<>"'`~|@_→←↑↓…]*$/u, // no letters at all
  /^[{}A-Z0-9:\-_ ]+$/, // document-number formats and codes: {CUST}-{DD}{MM}{YYYY}, KTP, PPh 23 …
  /^\+?62[\d\s-]*$/, // phone samples
  /^[a-z0-9_]+(, ?[a-z0-9_]+)+$/, // CSV column names: unit_number, unit_code, zone
  /^(Rp|IDR|WIB|CSV|PDF|KTP|NPWP|NIB|PPN|PPh|KYC|WhatsApp|Booqable|Privy|Xendit|QRIS|VA|API|URL|ID|OK|E\.164|m²|m³|x|×|SPV)$/,
];

function allowed(text) {
  // A leading separator does not make a brand or code translatable: " · WhatsApp".
  const s = text.replace(/\s+/g, " ").trim().replace(/^[·•—–-] /, "");
  if (!s) return true;
  return ALLOW.some((re) => re.test(s));
}

function files(rel) {
  const abs = path.join(src, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [abs];
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, e.name);
    if (e.isDirectory()) out.push(...files(path.relative(src, p)));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function scan(file) {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits = [];
  const report = (node, value) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    hits.push({ line: line + 1, text: value.replace(/\s+/g, " ").trim().slice(0, 80) });
  };
  const isStr = (e) => e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e));
  const visit = (node) => {
    if (ts.isJsxText(node) && !allowed(node.text)) report(node, node.text);
    if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      const e = node.expression;
      if (isStr(e) && !allowed(e.text)) report(node, e.text);
      // {cond ? "Yes" : "No"} / {a || "fallback"}
      if (e && ts.isConditionalExpression(e)) {
        for (const b of [e.whenTrue, e.whenFalse]) if (isStr(b) && !allowed(b.text)) report(b, b.text);
      }
      if (e && ts.isBinaryExpression(e) && isStr(e.right) && !allowed(e.right.text)) report(e.right, e.right.text);
    }
    if (ts.isJsxAttribute(node) && PROPS.has(node.name.getText(sf)) && node.initializer) {
      const init = node.initializer;
      const lit = ts.isStringLiteral(init) ? init : ts.isJsxExpression(init) && isStr(init.expression) ? init.expression : null;
      if (lit && !allowed(lit.text)) report(node, lit.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function flatKeys(obj, prefix = "") {
  return Object.entries(obj).flatMap(([k, v]) => (v && typeof v === "object" ? flatKeys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
}

const summary = process.argv.includes("--summary");
let failures = 0;

const checked = CHECKED.flatMap(files);
for (const f of checked) {
  const hits = scan(f);
  if (!hits.length) continue;
  failures += hits.length;
  const rel = path.relative(root, f);
  if (summary) console.log(String(hits.length).padStart(4), rel);
  else for (const h of hits) console.log(`${rel}:${h.line}  ${JSON.stringify(h.text)}`);
}

const id = JSON.parse(fs.readFileSync(path.join(root, "messages/id.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(root, "messages/en.json"), "utf8"));
const ki = new Set(flatKeys(id));
const ke = new Set(flatKeys(en));
const onlyId = [...ki].filter((k) => !ke.has(k));
const onlyEn = [...ke].filter((k) => !ki.has(k));
for (const k of onlyId) console.log(`messages: "${k}" is in id.json but not en.json`);
for (const k of onlyEn) console.log(`messages: "${k}" is in en.json but not id.json`);
failures += onlyId.length + onlyEn.length;

// Every t("key") used anywhere in the console must exist.
const used = new Set();
for (const f of [...files("app"), ...files("components"), ...files("lib")]) {
  for (const m of fs.readFileSync(f, "utf8").matchAll(/\b(?:t|tr)\(\s*["'`]([a-zA-Z0-9_.]+)["'`]/g)) used.add(m[1]);
}
const missing = [...used].filter((k) => !ki.has(k));
for (const k of missing) console.log(`messages: t("${k}") is used but missing from id.json`);
failures += missing.length;

console.log(`\n${checked.length} files checked, ${ki.size} message keys, ${failures} problem(s).`);
process.exit(failures ? 1 : 0);
