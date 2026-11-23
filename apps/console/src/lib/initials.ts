/**
 * The two letters in the user badge: the first letter of the first name and
 * of the last name ("Johnson Leonardi" -> "JL"). One-word names give their
 * first two letters; no name falls back to the email's local part.
 */
export function initials(displayName: string | null | undefined, email?: string | null): string {
  const words = (displayName ?? "")
    .replace(/\(.*?\)/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  const local = (email ?? "").split("@")[0]!.replace(/[^\p{L}\p{N}]/gu, "");
  return (local.slice(0, 2) || "?").toUpperCase();
}
