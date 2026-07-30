interface EmbeddedReleaseNote {
  schemaVersion: 1;
  tagName: string;
  title: Record<string, string>;
  items: Array<Record<string, string>>;
}

const EMBEDDED_NOTE_PATTERN =
  /<!--\s*corerobin-release-note:([^\s]+)\s*-->/;

export function localizeUpdateReleaseNotes(
  notes: string | null,
  language: string | undefined,
): string | null {
  if (!notes) return null;
  const match = notes.match(EMBEDDED_NOTE_PATTERN);
  if (!match?.[1]) return notes.trim() || null;
  try {
    const note = JSON.parse(
      decodeURIComponent(match[1]),
    ) as EmbeddedReleaseNote;
    if (
      note.schemaVersion !== 1
      || !/^v\d+\.\d+\.\d+$/.test(note.tagName)
      || !Array.isArray(note.items)
    ) {
      return notes.trim() || null;
    }
    const locale = language && note.title[language] ? language : "en";
    const title = note.title[locale] || note.title.en;
    const items = note.items
      .map((item) => item[locale] || item.en)
      .filter((item): item is string => Boolean(item?.trim()));
    if (!title?.trim() || items.length === 0) return notes.trim() || null;
    return `${title}\n\n${items.map((item) => `• ${item}`).join("\n")}`;
  } catch {
    return notes.trim() || null;
  }
}
