"use client";

import { useState, type FormEvent } from "react";
import { usePoll } from "../hooks/usePoll";
import { MCP_URL, listTools, runTool, toArguments, type McpAnswer, type McpTool } from "../lib/mcp";
import { Button, ButtonLink, Card, CopyButton, ExternalLink, Field, Notice, PageHeader, Skeleton, cx, inputClass } from "./ui";

const EXAMPLES: Record<string, Record<string, string>> = {
  check_account: { address: "0x522b92bcc19d01fe7585a9823435fe8204bde0e0" },
  storm_test: { address: "0x522b92bcc19d01fe7585a9823435fe8204bde0e0" },
  get_protection: { account: "alice.lifeline-team.testnet", network: "testnet" },
  prepare_policy: { account: "alice.lifeline-team.testnet", network: "testnet", hl_address: "0x522b92bcc19d01fe7585a9823435fe8204bde0e0" },
  prepare_pause: { account: "alice.lifeline-team.testnet", network: "testnet" },
  prepare_withdrawal: { account: "alice.lifeline-team.testnet", network: "testnet", amount_usdc: "1" },
  explain_refusal: { code: "BAD_QUOTE" },
};

const LIMITS = [
  ["It has no key", "The server can't sign anything. Every change is an unsigned transaction a person opens in their own wallet."],
  ["It can't pick the payee", "The vault only pays the Hyperliquid address in the user's policy, whatever an agent asks for."],
  ["It can't be talked round", "Tools return codes, numbers and addresses. Text that strangers wrote, like key names, never reaches the model."],
  ["It can't say safe by accident", "A reading that fails is an error that says the health is unknown."],
] as const;

const command = `claude mcp add --transport http lifeline ${MCP_URL}`;
const json = JSON.stringify({ mcpServers: { lifeline: { type: "http", url: MCP_URL } } }, null, 2);

export function AgentsView() {
  return (
    <>
      <PageHeader eyebrow="For AI agents" title="Let your agent read the sea">
        Connect any AI agent to Lifeline. It can check an account, storm-test it and prepare a protection policy. You stay the only one who can sign.
      </PageHeader>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <Card className="overflow-hidden lg:col-span-7">
          <p className="border-b-2 border-ink bg-sun px-5 py-3 text-[17px] font-bold">Connect it</p>
          <div className="flex flex-col gap-5 p-5">
            <Snippet label="Claude Code" text={command} />
            <Snippet label="Any MCP client" text={json} />
            <p className="text-[14px] leading-relaxed text-body">
              Streamable HTTP, no sign-in. For agents that read docs first: <ExternalLink href="/llms.txt">llms.txt</ExternalLink>, <ExternalLink href="/skill.md">a skill file</ExternalLink> and{" "}
              <ExternalLink href="https://github.com/Prashant-thakur77/LifeLine/blob/main/docs/agents.md">the guide</ExternalLink>.
            </p>
          </div>
        </Card>
        <div className="rounded-xl border-2 border-ink bg-sea p-5 text-paper lg:col-span-5">
          <h2 className="text-[clamp(26px,3vw,38px)] font-extrabold uppercase leading-[0.92] [font-variation-settings:'wdth'_72]">What it can&apos;t do</h2>
          <dl className="mt-4 divide-y-2 divide-paper/25">
            {LIMITS.map(([title, body]) => (
              <div key={title} className="py-3">
                <dt className="text-[16px] font-bold">{title}</dt>
                <dd className="mt-0.5 text-[14px] leading-relaxed text-paper/90">{body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <Console />
    </>
  );
}

function Snippet({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-semibold">{label}</p>
        <CopyButton value={text} />
      </div>
      <pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-ink p-4 font-mono text-[13px] leading-relaxed text-paper">{text}</pre>
    </div>
  );
}

/** The real tools, run from here exactly as an agent would. */
function Console() {
  const tools = usePoll("mcp:tools", () => listTools(), null);
  const [name, setName] = useState("storm_test");
  const tool = tools.data?.find((t) => t.name === name) ?? tools.data?.[0];
  return (
    <section aria-labelledby="console-title" className="mt-14">
      <h2 id="console-title" className="text-[clamp(34px,4.6vw,64px)] font-extrabold uppercase leading-[0.88] [font-variation-settings:'wdth'_70]">
        Be the agent
      </h2>
      <p className="mt-3 max-w-xl text-[16px] text-body">These buttons call the live server with the same messages an agent sends.</p>
      {tools.error ? (
        <Notice tone="warn" title="The server didn't answer" className="mt-6">
          {tools.error.message}
        </Notice>
      ) : !tool ? (
        <Skeleton className="mt-6 h-80" />
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-12">
          <div role="group" aria-label="Tools" className="flex flex-wrap gap-2 lg:col-span-3 lg:flex-col lg:items-stretch">
            {tools.data!.map((t) => (
              <button
                key={t.name}
                type="button"
                aria-pressed={t.name === tool.name}
                onClick={() => setName(t.name)}
                className={cx("rounded-lg border-2 border-ink px-3 py-2 text-left font-readout text-[12.5px] transition-transform active:translate-y-px", t.name === tool.name ? "bg-ink text-paper" : "bg-card hover:bg-sun")}
              >
                {t.name}
              </button>
            ))}
          </div>
          <Runner key={tool.name} tool={tool} />
        </div>
      )}
    </section>
  );
}

function Runner({ tool }: { tool: McpTool }) {
  const [typed, setTyped] = useState<Record<string, string>>(EXAMPLES[tool.name] ?? {});
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<McpAnswer | null>(null);
  const run = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      setAnswer(await runTool(tool.name, toArguments(tool, typed)));
    } catch (error) {
      setAnswer({ isError: true, text: error instanceof Error ? error.message : "That didn't work." });
    } finally {
      setBusy(false);
    }
  };
  // Only a link back to this site is made clickable.
  const review = answer && !answer.isError ? /"reviewUrl": "(https:\/\/lifeline\.prashantthakur\.dev(\/[^"\\]*))"/.exec(answer.text)?.[2] : undefined;
  return (
    <>
      <form onSubmit={run} className="flex flex-col gap-4 rounded-xl border-2 border-ink bg-card p-5 lg:col-span-4">
        <h3 className="text-[18px] font-bold">{tool.title}</h3>
        <p className="text-[14px] leading-relaxed text-body">{tool.description}</p>
        {Object.entries(tool.inputSchema.properties).map(([key, prop]) => {
          const id = `mcp-${key}`;
          const required = tool.inputSchema.required?.includes(key) ?? false;
          const set = (value: string) => setTyped((t) => ({ ...t, [key]: value }));
          return (
            <Field key={key} htmlFor={id} label={`${key}${required ? "" : " (optional)"}`} hint={prop.description}>
              {prop.enum ? (
                <select id={id} className={inputClass} value={typed[key] ?? ""} required={required} onChange={(e) => set(e.target.value)}>
                  <option value="">Choose</option>
                  {prop.enum.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input id={id} className={cx(inputClass, "num")} value={typed[key] ?? ""} required={required} spellCheck={false} autoCapitalize="none" inputMode={prop.type === "string" ? "text" : "decimal"} onChange={(e) => set(e.target.value)} />
              )}
            </Field>
          );
        })}
        <Button type="submit" variant="primary" size="lg" busy={busy}>
          Run {tool.name}
        </Button>
      </form>
      <div className="min-w-0 lg:col-span-5">
        <pre
          aria-live="polite"
          tabIndex={0}
          aria-label="The tool's answer"
          className={cx("max-h-[560px] min-h-60 overflow-auto whitespace-pre-wrap break-words rounded-xl border-2 border-ink p-5 font-mono text-[12.5px] leading-relaxed", answer?.isError ? "bg-[#ffe1e4] text-ink" : "bg-ink text-paper")}
        >
          {answer ? answer.text : "The answer comes back here, as the agent sees it."}
        </pre>
        {review ? (
          <ButtonLink href={review} className="mt-4">
            Review it as the user would
          </ButtonLink>
        ) : null}
      </div>
    </>
  );
}
