import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import { PageHeader } from "../../components/ui";
import { parseChangelog } from "../../lib/changelog";

export const metadata: Metadata = { title: "Changelog" };

const REPO = "https://github.com/Prashant-thakur77/LifeLine";
// Read when the site is built: the page and the repo's file can't say different things.
const chapters = parseChangelog(readFileSync(join(process.cwd(), "..", "..", "CHANGELOG.md"), "utf8"));

export default function ChangelogPage() {
  return (
    <>
      <PageHeader eyebrow="Changelog" title="Every release">
        What was submitted for NEAR HACKATHON, and what came after it. Dates are UTC.
      </PageHeader>
      {chapters.map((chapter) => (
        <section key={chapter.title} className="mb-10 overflow-hidden rounded-xl border-2 border-ink bg-card">
          <h2 className={`border-b-2 border-ink px-5 py-4 text-[clamp(24px,3vw,38px)] font-extrabold uppercase leading-none [font-variation-settings:'wdth'_72] ${chapter.title.startsWith("Submitted") ? "bg-sun" : "bg-sea text-paper"}`}>{chapter.title}</h2>
          <ol>
            {chapter.releases.map((r) => {
              const submitted = r.tag === "hackathon-submission";
              return (
                <li key={r.tag} className={`grid gap-x-5 gap-y-1 border-t-2 border-ink/10 px-5 py-4 first:border-t-0 sm:grid-cols-[110px_200px_1fr] ${submitted ? "bg-[#fff1c9]" : ""}`}>
                  <time dateTime={r.date} className="font-readout text-[12.5px] leading-6 text-muted">{r.date}</time>
                  <a href={submitted ? `${REPO}/tree/${r.tag}` : `${REPO}/releases/tag/${r.tag}`} target="_blank" rel="noreferrer noopener" className="break-words text-[16px] font-bold text-ink underline decoration-2 underline-offset-4">
                    {r.tag}
                  </a>
                  <p className="text-[15px] leading-relaxed text-body">{r.line}</p>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </>
  );
}
