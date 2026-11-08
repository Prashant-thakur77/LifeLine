import type { Metadata } from "next";
import { Suspense } from "react";
import { LedgerView } from "../../components/LedgerView";
import { PageFallback } from "../../components/PageFallback";

export const metadata: Metadata = { title: "Public ledger" };

export default function LedgerPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <LedgerView />
    </Suspense>
  );
}
