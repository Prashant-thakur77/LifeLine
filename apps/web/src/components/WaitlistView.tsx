"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent } from "react";
import { MAX_NAME, MAX_NOTE } from "@lifeline/waitlist";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { ticketPng } from "../lib/ticket-image";
import {
  CHAIN_LABEL, CHOICES, EMPTY_DRAFT, ROLE_LABEL, SIZE_LABEL, STEPS, VENUE_LABEL, WANT_LABEL,
  joinWaitlist, leaveWaitlist, nextStep, problemWith, shareHref, toggle, understand, withStory,
  type Draft, type Step, type Ticket,
} from "../lib/waitlist";
import { Mark } from "./Shell";
import { Button, CopyButton, Field, Notice, PaperRule, cx, inputClass } from "./ui";

/** What Lifeline says at each step. It answers with what it just heard. */
function lineFor(step: Step, draft: Draft): string {
  const name = draft.name.trim() || "captain";
  switch (step) {
    case "name":
      return "Ahoy. Who's calling?";
    case "story":
      return `Good to hear you, ${name}. Tell me about your trading, the way you'd tell a friend.`;
    case "role":
      return "And what brings you here?";
    case "venues":
      return "Where do you hold your positions?";
    case "chains":
      return "Where does your spare money sit?";
    case "size":
      return "Roughly how much margin would you want watched?";
    case "wants":
      return draft.liquidated ? "Being liquidated is a rotten night. What should we build so it doesn't happen again?" : "What would make you come aboard?";
    case "email":
      return `Last one, ${name}. Where do we send word when your berth is ready?`;
  }
}

/** Types a line out. Screen readers, and anyone who asked for less motion, get it whole. */
function Typed({ text, reduced }: { text: string; reduced: boolean }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (reduced) return;
    setShown(0);
    const timer = setInterval(() => setShown((n) => (n >= text.length ? (clearInterval(timer), n) : n + 1)), 22);
    return () => clearInterval(timer);
  }, [text, reduced]);
  const upTo = reduced ? text.length : shown;
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden>
        {text.slice(0, upTo)}
        <span className={cx("-mr-[0.14em] ml-[0.05em] inline-block h-[0.72em] w-[0.09em] translate-y-[0.06em] bg-rescue", upTo >= text.length && "animate-pulse-soft")} />
        {/* The rest holds its place, so nothing below moves while it types. */}
        <span className="invisible">{text.slice(upTo)}</span>
      </span>
    </>
  );
}

function Choices<T extends string>({ legend, list, labels, chosen, many, onPick }: { legend: string; list: readonly T[]; labels: Record<T, string>; chosen: T[]; many: boolean; onPick: (item: T) => void }) {
  const name = useId();
  const box = useRef<HTMLFieldSetElement>(null);
  return (
    <fieldset
      ref={box}
      className="flex flex-wrap gap-3"
      onKeyDown={(event) => {
        // Number keys work only while these choices have the focus.
        const item = list[Number(event.key) - 1];
        if (item !== undefined && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          box.current?.querySelectorAll("input")[Number(event.key) - 1]?.focus();
          onPick(item);
        }
      }}
    >
      <legend className="sr-only">{legend}</legend>
      {list.map((item, i) => {
        const on = chosen.includes(item);
        return (
          <label
            key={item}
            className={cx(
              "wl-chip relative flex cursor-pointer select-none items-center gap-3 rounded-lg border-2 border-ink px-4 py-2.5 text-[16px] font-bold text-ink shadow-[3px_3px_0_var(--color-ink)] transition-[transform,box-shadow,background-color] duration-150 hover:-translate-y-px focus-within:outline focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-ink",
              on ? "translate-x-[2px] translate-y-[2px] bg-sun shadow-[1px_1px_0_var(--color-ink)]" : "bg-card",
            )}
            style={{ "--i": i } as CSSProperties}
          >
            <input type={many ? "checkbox" : "radio"} name={name} className="absolute inset-0 cursor-pointer opacity-0" checked={on} onChange={() => onPick(item)} />
            <span className="grid size-6 place-items-center rounded-sm border-[1.5px] border-ink bg-paper font-readout text-[11px]" aria-hidden>
              {on ? "✓" : i + 1}
            </span>
            {labels[item]}
          </label>
        );
      })}
    </fieldset>
  );
}

/** The boarding pass, filling in as the talk goes on. It leans towards the pointer. */
function Pass({ draft, ticket, reduced }: { draft: Draft; ticket: Ticket | null; reduced: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const lean = (event: PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || reduced || event.pointerType === "touch") return;
    const box = el.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    el.style.transform = `rotateX(${(-y * 14).toFixed(2)}deg) rotateY(${(x * 16).toFixed(2)}deg)`;
  };
  const rows: [string, string][] = [
    ["Here to", draft.role ? ROLE_LABEL[draft.role] : ""],
    ["Trades on", draft.venues.map((v) => VENUE_LABEL[v]).join(", ")],
    ["Money on", draft.chains.map((c) => CHAIN_LABEL[c]).join(", ")],
    ["Margin", draft.size ? SIZE_LABEL[draft.size] : ""],
    ["Asked for", draft.wants.map((w) => WANT_LABEL[w]).join(", ")],
  ];
  return (
    <div className="[perspective:1100px]" onPointerMove={lean} onPointerLeave={() => ref.current && (ref.current.style.transform = "")}>
      <div ref={ref} className="wl-pass relative overflow-hidden rounded-2xl border-2 border-ink bg-card transition-transform duration-300 ease-out will-change-transform">
        <div className="flex items-center justify-between border-b-2 border-ink bg-sun px-5 py-3">
          <span className="text-[19px] font-black uppercase [font-variation-settings:'wdth'_72]">Boarding pass</span>
          <Mark className={cx("size-8", ticket && "wl-spin")} />
        </div>
        <div className="px-5 pb-5 pt-4">
          <p className="font-readout text-[10.5px] uppercase tracking-[0.1em] text-muted">Passenger</p>
          <p className="min-h-[1.1em] break-words text-[34px] font-extrabold uppercase leading-none [font-variation-settings:'wdth'_72]">{draft.name.trim() || <span className="text-ink/20">You</span>}</p>
          <dl className="mt-4 grid gap-2.5 text-[14px]">
            {rows.map(([label, value]) => (
              <div key={label} className="grid grid-cols-[84px_1fr] gap-3 border-t border-line pt-2.5">
                <dt className="text-muted">{label}</dt>
                <dd key={value} className={cx("min-w-0 font-semibold", value && "wl-stamp")}>
                  {value || <span className="text-ink/25">·····</span>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="relative border-t-2 border-dashed border-ink px-5 py-4">
          <span className="absolute -left-3.5 -top-3.5 size-6 rounded-full border-2 border-ink bg-paper" aria-hidden />
          <span className="absolute -right-3.5 -top-3.5 size-6 rounded-full border-2 border-ink bg-paper" aria-hidden />
          <p className="font-readout text-[10.5px] uppercase tracking-[0.1em] text-muted">Berth</p>
          <p className={cx("font-readout text-[30px] leading-tight", ticket ? "wl-stamp text-rescue-ink" : "text-ink/20")}>{ticket?.berth ?? "···-···"}</p>
        </div>
      </div>
    </div>
  );
}

/** The sea under the talk: it rises a little with each answer, and the buoy comes closer. */
function Sea({ progress }: { progress: number }) {
  return (
    <div className="relative mt-12 h-28 overflow-hidden" aria-hidden>
      <div className="absolute inset-x-0 bottom-[46px]">
        <div className="transition-transform duration-1000 ease-out" style={{ transform: `translateX(calc(${progress} * (100% - 56px)))` }}>
          <Mark className="wl-bob size-14" />
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 transition-transform duration-1000 ease-out" style={{ transform: `translateY(${(1 - progress) * 18}px)` }}>
        <PaperRule className="h-9" />
        <div className="h-8 bg-sea-deep" />
      </div>
    </div>
  );
}

const PLACEHOLDER = "I trade perps on Hyperliquid with about $5k, my money sits on Base, and I got liquidated in my sleep…";

export function WaitlistView() {
  const reduced = useReducedMotion();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [trail, setTrail] = useState<Step[]>(["name"]);
  const [problem, setProblem] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const done = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  const step = trail.at(-1)!;
  const line = lineFor(step, draft);
  const heard = useMemo(() => understand(draft.note), [draft.note]);
  const progress = ticket ? 1 : STEPS.indexOf(step) / STEPS.length;

  // The next question takes the focus, so you can keep typing. Not on arrival: the page shouldn't jump.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    (input.current ?? form.current?.querySelector<HTMLElement>("fieldset input:checked, fieldset input"))?.focus({ preventScroll: true });
  }, [step]);
  useEffect(() => {
    if (ticket) done.current?.focus();
  }, [ticket]);

  const set = (change: Partial<Draft>) => {
    setProblem(null);
    setDraft((d) => ({ ...d, ...change }));
  };

  const back = () => {
    setProblem(null);
    setTrail((t) => t.slice(0, -1));
  };

  const go = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const wrong = problemWith(step, draft);
    if (wrong) {
      setProblem(wrong);
      input.current?.focus();
      return;
    }
    let after = draft;
    if (step === "story") {
      after = withStory(draft);
      setDraft(after);
    }
    const next = nextStep(step, after);
    if (next) {
      setProblem(null);
      setTrail((t) => [...t, next]);
      return;
    }
    if (!consent) {
      setProblem("Tick the box so we may keep your email.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      setTicket(await joinWaitlist(draft, website));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Something went wrong. Send it again.");
    } finally {
      setBusy(false);
    }
  };

  if (ticket) return <Aboard draft={draft} ticket={ticket} reduced={reduced} heading={done} />;

  const big = "w-full border-0 border-b-[3px] border-ink bg-transparent pb-2 text-[clamp(24px,3.4vw,40px)] font-bold text-ink placeholder:text-ink/25 outline-none focus:border-rescue focus-visible:rounded-none! focus-visible:shadow-none! focus-visible:outline-none!";
  const heardTags = [
    ...heard.venues.map((v) => VENUE_LABEL[v]),
    ...heard.chains.map((c) => `Money on ${CHAIN_LABEL[c]}`),
    ...(heard.size ? [SIZE_LABEL[heard.size]] : []),
    ...(heard.role ? [ROLE_LABEL[heard.role]] : []),
    ...(heard.liquidated === true ? ["Been liquidated"] : heard.liquidated === false ? ["Never liquidated"] : []),
  ];

  return (
    <div>
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_340px] lg:gap-14">
        <form ref={form} onSubmit={go} noValidate className="flex min-h-[440px] flex-col">
          <p className="mb-5 flex items-center gap-3 font-readout text-[11px] uppercase tracking-[0.08em] text-muted">
            <span className="rounded-sm bg-ink px-1.5 py-0.5 text-paper">Waitlist</span>
            Takes about a minute
          </p>
          <h1 className="text-[clamp(38px,5.6vw,72px)] font-extrabold uppercase leading-[0.92] tracking-[-0.01em] [font-variation-settings:'wdth'_70]" aria-live="polite">
            <Typed key={step} text={line} reduced={reduced} />
          </h1>

          <div key={step} className="wl-in mt-9">
            {step === "name" ? (
              <input ref={input} aria-label={line} aria-invalid={problem ? true : undefined} className={big} value={draft.name} maxLength={MAX_NAME} autoComplete="nickname" placeholder="Type your name" onChange={(e) => set({ name: e.target.value })} />
            ) : step === "story" ? (
              <>
                <textarea
                  ref={input}
                  aria-label={line}
                  rows={3}
                  className={cx(big, "resize-none leading-snug [field-sizing:content] min-h-[4.2em] max-sm:text-[21px]")}
                  value={draft.note}
                  maxLength={MAX_NOTE}
                  placeholder={PLACEHOLDER}
                  onChange={(e) => set({ note: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      form.current?.requestSubmit();
                    }
                  }}
                />
                <p className="mt-4 text-[13.5px] text-muted">{heardTags.length ? "I heard:" : "Say as much as you like, or press Enter to skip. I pick out what I need as you type."}</p>
                <ul className="mt-2 flex min-h-9 flex-wrap gap-2" aria-live="polite">
                  {heardTags.map((tag) => (
                    <li key={tag} className="wl-stamp rounded-sm border-2 border-ink bg-safe px-2.5 py-1 text-[14px] font-bold">
                      {tag}
                    </li>
                  ))}
                </ul>
              </>
            ) : step === "role" ? (
              <Choices legend={line} list={CHOICES.role} labels={ROLE_LABEL} chosen={draft.role ? [draft.role] : []} many={false} onPick={(role) => set({ role })} />
            ) : step === "venues" ? (
              <Choices legend={line} list={CHOICES.venues} labels={VENUE_LABEL} chosen={draft.venues} many onPick={(v) => set({ venues: toggle(draft.venues, v) })} />
            ) : step === "chains" ? (
              <Choices legend={line} list={CHOICES.chains} labels={CHAIN_LABEL} chosen={draft.chains} many onPick={(c) => set({ chains: toggle(draft.chains, c) })} />
            ) : step === "size" ? (
              <Choices legend={line} list={CHOICES.size} labels={SIZE_LABEL} chosen={draft.size ? [draft.size] : []} many={false} onPick={(size) => set({ size })} />
            ) : step === "wants" ? (
              <Choices
                legend={line}
                list={CHOICES.wants}
                labels={WANT_LABEL}
                chosen={draft.wants}
                many
                onPick={(w) => set({ wants: toggle(draft.wants, w) })}
              />
            ) : (
              <>
                <input ref={input} type="email" inputMode="email" autoComplete="email" aria-label={line} aria-invalid={problem ? true : undefined} className={big} value={draft.email} maxLength={120} placeholder="you@example.com" onChange={(e) => set({ email: e.target.value })} />
                <label className="mt-6 flex max-w-xl cursor-pointer items-start gap-3 text-[14.5px] leading-relaxed text-body">
                  <input type="checkbox" className="mt-1 size-5 shrink-0 accent-[#ff5a1f]" checked={consent} onChange={(e) => (setConsent(e.target.checked), setProblem(null))} />
                  <span>I&apos;m 18 or over, and Lifeline may keep these answers and email me about mainnet sign-up and what we build next.</span>
                </label>
                <details className="mt-3 max-w-xl text-[13.5px] leading-relaxed text-body">
                  <summary className="cursor-pointer font-semibold text-ink">What happens to it</summary>
                  <p className="mt-2">
                    We keep your name, email, choices and what you typed, on Cloudflare, for the Lifeline team to read. We don&apos;t sell or share it, and there is no tracking on this page. You
                    get a leave code: with it you can delete everything at the bottom of this page, any time. For anything else, message @LifelineNear on X.
                  </p>
                </details>
              </>
            )}
            {/* People never see this one; bots fill it. */}
            <div className="absolute -left-[9999px]" aria-hidden>
              <label>
                Website
                <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
              </label>
            </div>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            {trail.length > 1 ? (
              <Button variant="ghost" size="lg" onClick={back} disabled={busy}>
                ← Back
              </Button>
            ) : null}
            <Button type="submit" variant="primary" size="lg" busy={busy}>
              {busy ? "Taking your berth…" : step === "email" ? "Take my berth" : "Continue"}
            </Button>
            <span className="hidden font-readout text-[11.5px] text-muted sm:inline">{step === "name" || step === "story" || step === "email" ? "or press Enter ↵" : "number keys pick, Enter goes on"}</span>
          </div>
          <p role="alert" className="mt-4 min-h-6 text-[15px] font-semibold text-danger-ink">
            {problem}
          </p>
        </form>
        <div className="lg:pt-10">
          <Pass draft={step === "story" ? withStory(draft) : draft} ticket={null} reduced={reduced} />
        </div>
      </div>
      <div role="progressbar" aria-label="Waitlist" aria-valuemin={0} aria-valuemax={STEPS.length} aria-valuenow={STEPS.indexOf(step)}>
        <Sea progress={progress} />
      </div>
      <LeaveForm />
    </div>
  );
}

function Aboard({ draft, ticket, reduced, heading }: { draft: Draft; ticket: Ticket; reduced: boolean; heading: React.RefObject<HTMLHeadingElement | null> }) {
  const [saveError, setSaveError] = useState(false);
  const save = async () => {
    try {
      const url = URL.createObjectURL(await ticketPng(draft, ticket.berth));
      const a = document.createElement("a");
      a.href = url;
      a.download = `lifeline-${ticket.berth}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setSaveError(true);
    }
  };
  return (
    <div className="overflow-x-clip">
      <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-[1fr_400px] lg:gap-16">
        <div>
          <h1 ref={heading} tabIndex={-1} className="text-[clamp(52px,8vw,112px)] font-extrabold uppercase leading-[0.86] outline-none [font-variation-settings:'wdth'_70] focus-visible:shadow-none! focus-visible:outline-none!">
            <span className="kin-line">
              <span>You&apos;re</span>
            </span>
            <span className="kin-line">
              <span className="riso text-sea">aboard.</span>
            </span>
          </h1>
          <p className="mt-5 max-w-lg text-[16.5px] leading-relaxed text-body">
            Your berth is <strong className="text-ink">{ticket.berth}</strong>. We&apos;ll write to {draft.email.trim()} when mainnet sign-up opens. If that address was already on the list, the first entry stays and only its leave code works.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button variant="primary" size="lg" onClick={save}>
              Save my pass
            </Button>
            <a href={shareHref(ticket.berth)} target="_blank" rel="noreferrer noopener" className="inline-flex h-12 items-center rounded-lg border-2 border-ink bg-card px-5 text-[15px] font-bold shadow-[3px_3px_0_var(--color-ink)] hover:bg-paper-2">
              Post it on X
            </a>
          </div>
          {saveError ? <p role="alert" className="mt-3 text-[14px] text-danger-ink">Your browser couldn&apos;t make the picture. A screenshot works too.</p> : null}
          <Notice tone="warn" title="Keep your leave code" className="mt-8 max-w-lg" action={<CopyButton value={ticket.leaveCode} label="Copy the code" />}>
            <code className="break-all font-readout text-[13px]">{ticket.leaveCode}</code>
            <br />
            It deletes the entry made just now, and we can&apos;t show it again.
          </Notice>
        </div>
        <div className="wl-land">
          <Pass draft={draft} ticket={ticket} reduced={reduced} />
        </div>
      </div>
      <Sea progress={1} />
      <LeaveForm />
    </div>
  );
}

function LeaveForm() {
  const id = useId();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <details className="mt-8 rounded-xl border-2 border-ink bg-card px-5 py-4">
      <summary className="cursor-pointer text-[15px] font-bold">Already aboard and want off?</summary>
      <form
        className="mt-4 grid max-w-2xl gap-4 sm:grid-cols-2"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await leaveWaitlist(email, code);
            setSaid({ ok: true, text: "If that email and code match an entry, it's deleted." });
          } catch (error) {
            setSaid({ ok: false, text: error instanceof Error ? error.message : "That didn't work." });
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Email" htmlFor={`${id}-email`}>
          <input id={`${id}-email`} type="email" required className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </Field>
        <Field label="Leave code" htmlFor={`${id}-code`}>
          <input id={`${id}-code`} required className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Button type="submit" variant="danger" busy={busy} className="w-fit">
          Delete my entry
        </Button>
        {said ? (
          <p role="status" className={cx("self-center text-[14px]", said.ok ? "text-safe-ink" : "text-danger-ink")}>
            {said.text}
          </p>
        ) : null}
      </form>
    </details>
  );
}
