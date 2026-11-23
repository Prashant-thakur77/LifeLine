import type { Metadata } from "next";
import { AgentsView } from "../../components/AgentsView";

export const metadata: Metadata = { title: "For AI agents", description: "An MCP server that lets AI agents read Hyperliquid risk and prepare Lifeline policies, with nothing they can steal." };

export default function AgentsPage() {
  return <AgentsView />;
}
