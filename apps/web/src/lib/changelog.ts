export type Release = { date: string; tag: string; line: string };
export type Chapter = { title: string; releases: Release[] };

/** CHANGELOG.md as data. A line in a list that doesn't read as a release is an error, so none goes missing from the page. */
export function parseChangelog(text: string): Chapter[] {
  const chapters: Chapter[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) chapters.push({ title: line.slice(3).trim(), releases: [] });
    else if (line.startsWith("- ")) {
      const found = /^- (\d{4}-\d{2}-\d{2}) · (\S+) · (.+)$/.exec(line);
      const chapter = chapters.at(-1);
      if (!found || !chapter) throw new Error(`CHANGELOG.md: can't read "${line}"`);
      chapter.releases.push({ date: found[1]!, tag: found[2]!, line: found[3]! });
    }
  }
  return chapters;
}
