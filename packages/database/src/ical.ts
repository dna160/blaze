export interface IcalEvent {
  uid: string;
  startDate: Date;
  endDate: Date;
  summary?: string;
}

/**
 * Minimal RFC5545 VEVENT generator for the outbound Asset calendar feed
 * (PRD §13 "OTA channel sync", Session 22) — no recurrence, no
 * timezones, whole-day `VALUE=DATE` blocking only. That's the standard
 * shape for a "these nights are reserved" export, which is all a
 * tenant's Airbnb/Booking.com listing needs to import to avoid a
 * double-booking.
 */
export function generateIcalFeed(calendarName: string, events: IcalEvent[]): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//RentOS//Booking Calendar//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeIcalText(calendarName)}`,
  ];
  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}`,
      `DTSTAMP:${formatIcalDateTime(new Date())}`,
      `DTSTART;VALUE=DATE:${formatIcalDate(event.startDate)}`,
      `DTEND;VALUE=DATE:${formatIcalDate(event.endDate)}`,
      `SUMMARY:${escapeIcalText(event.summary ?? "Reserved")}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function formatIcalDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function formatIcalDateTime(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

function escapeIcalText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/**
 * Minimal VEVENT extractor for inbound sync (apps/worker's
 * sync-ota-calendars job) — pulls UID/DTSTART/DTEND out of a real
 * Airbnb/Booking.com/VRBO-style export feed. Deliberately does NOT
 * handle RRULE (recurrence), VTIMEZONE, or other RFC5545 features: an
 * OTA's "these nights are reserved" export is, in practice, always a
 * flat list of non-recurring VEVENTs — a full ICS parser would be a lot
 * of unused complexity for what this needs. Unfolds RFC5545 line
 * continuations (a leading space/tab on the next line) before parsing,
 * since real feeds do wrap long lines that way.
 */
export function parseIcalEvents(icsText: string): IcalEvent[] {
  const unfolded = icsText.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
  const lines = unfolded.split(/\r\n|\n/);

  const events: IcalEvent[] = [];
  let current: { uid?: string; startRaw?: string; endRaw?: string } | null = null;

  for (const line of lines) {
    if (line.startsWith("BEGIN:VEVENT")) {
      current = {};
    } else if (line.startsWith("END:VEVENT")) {
      if (current?.uid && current.startRaw && current.endRaw) {
        const startDate = parseIcalDate(current.startRaw);
        const endDate = parseIcalDate(current.endRaw);
        if (startDate && endDate) events.push({ uid: current.uid, startDate, endDate });
      }
      current = null;
    } else if (current) {
      if (line.startsWith("UID:")) {
        current.uid = line.slice("UID:".length).trim();
      } else if (line.startsWith("DTSTART")) {
        current.startRaw = line.split(":")[1]?.trim();
      } else if (line.startsWith("DTEND")) {
        current.endRaw = line.split(":")[1]?.trim();
      }
    }
  }
  return events;
}

function parseIcalDate(raw: string): Date | null {
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (dateOnly) {
    return new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])));
  }
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(raw);
  if (dateTime) {
    return new Date(
      Date.UTC(
        Number(dateTime[1]),
        Number(dateTime[2]) - 1,
        Number(dateTime[3]),
        Number(dateTime[4]),
        Number(dateTime[5]),
        Number(dateTime[6]),
      ),
    );
  }
  return null;
}
