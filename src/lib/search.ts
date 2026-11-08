export const normalizeSearch = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
export function searchEntries<T extends { title: string; text: string }>(
  entries: T[],
  query: string,
): T[] {
  const words = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...entries];
  return entries
    .map((entry, index) => {
      const title = normalizeSearch(entry.title),
        all = `${title} ${normalizeSearch(entry.text)}`;
      return {
        entry,
        index,
        score: words.every((word) => all.includes(word))
          ? words.reduce(
              (s, w) =>
                s + (title.includes(w) ? 3 : 1) + (title.startsWith(w) ? 2 : 0),
              0,
            )
          : 0,
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.entry);
}
