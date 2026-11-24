// The waitlist's numbers, for the team: pnpm waitlist:stats (reads WAITLIST_ADMIN_TOKEN from .env)
const LABEL = { x: "X", discord: "our Discord posts", "hl-discord": "Hyperliquid's Discord", telegram: "Telegram", reddit: "Reddit", other: "other links", direct: "no tagged link" };
const base = (process.env.WAITLIST_URL ?? "https://lifeline-waitlist.prashantthakur.dev").replace(/\/+$/, "");
const answer = await fetch(`${base}/api/stats`, { headers: { authorization: `Bearer ${process.env.WAITLIST_ADMIN_TOKEN?.trim() ?? ""}` } });
if (!answer.ok) {
  console.error(`The waitlist answered ${answer.status}. Is WAITLIST_ADMIN_TOKEN in .env right?`);
  process.exit(1);
}
const { at, total, bySource } = await answer.json();
console.log(`${at}: ${total.traders} traders on the waitlist, ${total.all} people in all.`);
for (const [source, n] of Object.entries(bySource).sort((a, b) => b[1].all - a[1].all)) console.log(`  ${n.traders} traders, ${n.all} in all, from ${LABEL[source] ?? source}`);
console.log("\nLinks to post:");
for (const source of Object.keys(LABEL).slice(0, 5)) console.log(`  ${LABEL[source]}: https://lifeline.prashantthakur.dev/waitlist?utm_source=${source}`);
