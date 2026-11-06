// Prints a real snapshot: pnpm --filter hyperliquid live <address>
import { formatHealthResult } from "./format";
import { getHealth } from "./health";

const address = process.argv[2];
if (!address) {
  console.error("usage: pnpm --filter hyperliquid live <0x address>");
  process.exit(2);
}

const result = await getHealth(address);
console.log(formatHealthResult(result));
process.exit(result.status === "ok" ? 0 : 1);
