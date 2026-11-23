"use client";

import { useState } from "react";
import type { PolicyDraft } from "../lib/policy";
import { heardText, sayPolicy } from "../lib/say-policy";
import { Button, cx } from "./ui";

const EXAMPLES = ["Rescue me below 1.6, refill to 2.2, at most $20 a day", "Warn me at 2, step in at 1.4, 10 USDC per rescue, wait 5 minutes between rescues"];

/** Rules in plain words. Shows what it understood as you type; nothing changes until you press the button. */
export function SayIt({ onApply }: { onApply: (changes: Partial<PolicyDraft>) => void }) {
  const [text, setText] = useState("");
  const [applied, setApplied] = useState(false);
  const said = sayPolicy(text);
  const write = (value: string) => {
    setText(value);
    setApplied(false);
  };
  return (
    <div className="rounded-xl border-2 border-ink bg-sun p-5 sm:p-6">
      <label htmlFor="say-it" className="text-[clamp(24px,3vw,36px)] font-extrabold uppercase leading-none [font-variation-settings:'wdth'_72]">
        Say your rules
      </label>
      <textarea
        id="say-it"
        rows={2}
        maxLength={600}
        value={text}
        onChange={(e) => write(e.target.value)}
        placeholder={EXAMPLES[0]}
        className="mt-3 w-full resize-none rounded-lg border-2 border-ink bg-card p-4 text-[18px] font-semibold leading-snug outline-none [field-sizing:content] placeholder:text-muted focus:shadow-[3px_3px_0_var(--color-sea)]"
      />
      <div aria-live="polite">
        {text.trim() === "" ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button key={example} type="button" onClick={() => write(example)} className="rounded-sm border-2 border-ink bg-card px-2.5 py-1 text-left text-[13.5px] font-semibold hover:bg-paper-2">
                {example}
              </button>
            ))}
          </div>
        ) : (
          <>
            <ul className="mt-3 flex flex-wrap gap-2">
              {said.heard.map((item) => (
                <li key={`${item.field}:${item.value}`} className="wl-stamp rounded-sm border-2 border-ink bg-safe px-2.5 py-1 text-[14px] font-bold">
                  {item.label} <span className="num">{heardText(item)}</span>
                </li>
              ))}
              {said.clashes.map((label) => (
                <li key={label} className="rounded-sm border-2 border-ink bg-[#ffe1e4] px-2.5 py-1 text-[14px] font-bold">
                  {label}: said two ways, so neither is used
                </li>
              ))}
            </ul>
            {said.unused.length > 0 ? <p className="mt-2 text-[14px] text-ink">Not used: {said.unused.join(", ")}. Say what it&apos;s for, or set it below.</p> : null}
            {said.heard.length === 0 && said.unused.length === 0 && said.clashes.length === 0 ? <p className="mt-2 text-[14px] text-ink">Nothing I can use yet. Try &ldquo;rescue me below 1.5&rdquo;.</p> : null}
          </>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <Button
          variant="secondary"
          disabled={said.heard.length === 0}
          onClick={() => {
            onApply(said.changes);
            setApplied(true);
          }}
        >
          Put it in the form
        </Button>
        <p role="status" className={cx("text-[14px] text-ink", !applied && "sr-only")}>
          {applied ? "Done. Check it below; nothing is signed yet." : ""}
        </p>
      </div>
      <p className="mt-3 text-[13px] text-ink">Read here in your browser by fixed rules, not by an AI, so it never guesses.</p>
    </div>
  );
}
