import type { Metadata } from "next";
import { Suspense } from "react";
import { AutopsyView } from "../../components/AutopsyView";
import { PageFallback } from "../../components/PageFallback";

export const metadata: Metadata = { title: "Liquidation autopsy", description: "What happened after each of your Hyperliquid liquidations, and what it would have taken to hold on." };

export default function AutopsyPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <AutopsyView />
    </Suspense>
  );
}
