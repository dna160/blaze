import type { Prisma } from "../../generated/client/index.js";

import { parseCsv } from "./csv.js";

/**
 * PRD go-live §5.3 — bulk unit import (Console → Inventory → "Import units").
 *
 * Input: the data pack's kebon-jeruk-units.csv shape —
 *   unit_number, unit_code, zone, unit_type_slug, notes
 *
 * Rules:
 *   - upsert by (tenant, unit_code); codes keep the legacy STORAGE-<n> form;
 *   - a row without a type, an unknown type slug, a duplicate code or a
 *     missing zone is an error — and any error blocks the whole apply;
 *   - it never deletes: units in the database but not in the file are only
 *     reported;
 *   - it never touches a unit's status, and refuses to change the type of a
 *     unit that is currently rented.
 *
 * Runs inside the caller's tenant context (assets/asset_types are RLS-scoped).
 */

export interface UnitImportRow {
  line: number;
  code: string;
  unitNumber: number | null;
  zone: string | null;
  typeSlug: string | null;
  action: "create" | "update" | "unchanged" | "error";
  errors: string[];
}

export interface UnitImportPlan {
  rows: UnitImportRow[];
  /** Codes in the database that the file does not mention — reported, never removed. */
  missingFromFile: string[];
  summary: { create: number; update: number; unchanged: number; error: number };
  canApply: boolean;
}

const OCCUPYING = ["RESERVED", "OCCUPIED"];

export async function planUnitImport(tx: Prisma.TransactionClient, tenantId: string, csv: string): Promise<UnitImportPlan> {
  const parsed = parseCsv(csv);
  const types = await tx.assetType.findMany({ where: { tenantId }, select: { id: true, slug: true } });
  const typeBySlug = new Map(types.map((t) => [t.slug, t.id]));
  const existing = await tx.asset.findMany({
    where: { tenantId },
    select: { id: true, code: true, zone: true, assetTypeId: true, status: true, attributes: true },
  });
  const byCode = new Map(existing.map((a) => [a.code, a]));
  const seen = new Map<string, number>();

  const rows: UnitImportRow[] = parsed.map((r, i) => {
    const line = i + 2; // 1-based, after the header
    const code = (r.unit_code ?? "").trim();
    const zone = (r.zone ?? "").trim().toUpperCase() || null;
    const typeSlug = (r.unit_type_slug ?? "").trim() || null;
    const unitNumber = r.unit_number?.trim() ? Number(r.unit_number) : null;
    const errors: string[] = [];

    if (!code) errors.push("unit_code is empty");
    else if (seen.has(code)) errors.push(`duplicate unit_code (also on line ${seen.get(code)})`);
    if (code) seen.set(code, line);
    if (!zone) errors.push("zone is empty");
    if (!typeSlug) errors.push("unit_type_slug is empty — every unit needs its type (Small/Medium/…)");
    else if (!typeBySlug.has(typeSlug)) errors.push(`unknown unit_type_slug "${typeSlug}" (known: ${[...typeBySlug.keys()].join(", ")})`);
    if (unitNumber !== null && !Number.isInteger(unitNumber)) errors.push(`unit_number "${r.unit_number}" is not a whole number`);

    const current = code ? byCode.get(code) : undefined;
    const typeId = typeSlug ? typeBySlug.get(typeSlug) : undefined;
    if (current && typeId && current.assetTypeId !== typeId && OCCUPYING.includes(current.status)) {
      errors.push(`${code} is ${current.status.toLowerCase()} — its type cannot change while rented`);
    }

    let action: UnitImportRow["action"] = "error";
    if (errors.length === 0) {
      const attrs = (current?.attributes ?? {}) as { unitNumber?: number };
      action = !current
        ? "create"
        : current.zone === zone && current.assetTypeId === typeId && (unitNumber === null || attrs.unitNumber === unitNumber)
          ? "unchanged"
          : "update";
    }
    return { line, code, unitNumber, zone, typeSlug, action, errors };
  });

  const inFile = new Set(rows.map((r) => r.code));
  const missingFromFile = existing.map((a) => a.code).filter((c) => !inFile.has(c)).sort();
  const summary = { create: 0, update: 0, unchanged: 0, error: 0 };
  for (const r of rows) summary[r.action]++;
  return { rows, missingFromFile, summary, canApply: rows.length > 0 && summary.error === 0 };
}

/** Apply a plan with zero errors. Returns the plan that was applied (re-planned inside the same transaction). */
export async function applyUnitImport(tx: Prisma.TransactionClient, tenantId: string, csv: string, opts: { locationId: string | null }): Promise<UnitImportPlan> {
  const plan = await planUnitImport(tx, tenantId, csv);
  if (!plan.canApply) return plan;
  const types = new Map((await tx.assetType.findMany({ where: { tenantId }, select: { id: true, slug: true } })).map((t) => [t.slug, t.id]));
  for (const row of plan.rows) {
    if (row.action === "unchanged") continue;
    const assetTypeId = types.get(row.typeSlug!)!;
    const existing = await tx.asset.findUnique({ where: { tenantId_code: { tenantId, code: row.code } } });
    const attributes = { ...((existing?.attributes as Record<string, unknown>) ?? {}), ...(row.unitNumber !== null ? { unitNumber: row.unitNumber } : {}) };
    if (existing) {
      await tx.asset.update({ where: { id: existing.id }, data: { assetTypeId, zone: row.zone, attributes: attributes as Prisma.InputJsonValue } });
    } else {
      await tx.asset.create({
        data: { tenantId, code: row.code, assetTypeId, zone: row.zone, locationId: opts.locationId, attributes: attributes as Prisma.InputJsonValue },
      });
    }
  }
  return plan;
}
