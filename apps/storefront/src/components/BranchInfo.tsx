import type { BranchPublicProfile } from "@rentos/contracts";

import { hoursLine, waLink } from "@/lib/branch";

/**
 * PRD go-live §5.1/§5.2 — what the branch offers and how to reach its CS:
 * address, opening hours, facilities from the quotation, WhatsApp and phone.
 * Server-renderable (no hooks).
 */
export function BranchInfo({ profile, compact = false }: { profile: BranchPublicProfile; compact?: boolean }) {
  const wa = waLink(profile.contact.whatsapp, `Halo ${profile.name}, saya ingin bertanya tentang sewa storage.`);
  const hours = hoursLine(profile.operatingHours);
  return (
    <div className={`rounded-xl border border-brand-600/10 bg-white ${compact ? "p-4" : "p-6"}`}>
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-3 text-sm">
          {profile.address.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-accent-500">Alamat / Address</p>
              <address className="mt-1 not-italic text-brand-700/80">
                {profile.address.map((l) => (
                  <span key={l} className="block">
                    {l}
                  </span>
                ))}
              </address>
            </div>
          )}
          {hours && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-accent-500">Jam operasional / Opening hours</p>
              <p className="mt-1 text-brand-700/80">{hours}</p>
              <p className="text-xs text-brand-700/60">Akses di luar jam kerja dengan janji (biaya lembur berlaku). / Access outside these hours by appointment (overtime fee applies).</p>
            </div>
          )}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-accent-500">Customer service</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {wa && (
                <a href={wa} target="_blank" rel="noreferrer" className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700">
                  WhatsApp {profile.contact.whatsappDisplay ?? profile.contact.whatsapp}
                </a>
              )}
              {profile.contact.phone && (
                <a href={`tel:${profile.contact.phone.replace(/[^\d+]/g, "")}`} className="rounded border border-brand-600/20 px-3 py-1.5 text-xs text-brand-700 hover:border-accent-500">
                  Tel {profile.contact.phone}
                </a>
              )}
              {profile.contact.email && (
                <a href={`mailto:${profile.contact.email}`} className="rounded border border-brand-600/20 px-3 py-1.5 text-xs text-brand-700 hover:border-accent-500">
                  {profile.contact.email}
                </a>
              )}
            </div>
          </div>
        </div>
        {profile.facilities.length > 0 && (
          <div className="text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-accent-500">Fasilitas / Facilities</p>
            <ul className="mt-2 space-y-1.5">
              {profile.facilities.map((f) => (
                <li key={f} className="flex gap-2 text-brand-700/80">
                  <span aria-hidden className="text-green-600">✓</span>
                  {f}
                </li>
              ))}
            </ul>
            {profile.facilities.some((f) => f.includes("*")) && (
              <p className="mt-2 text-xs text-brand-700/50">* Syarat dan ketentuan berlaku. / Terms apply.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
