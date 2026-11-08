import type { Metadata } from "next";
import { Suspense } from "react";
import { HistoryView } from "../../components/HistoryView";
import { PageFallback } from "../../components/PageFallback";

export const metadata: Metadata = { title: "History" };

export default function HistoryPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <HistoryView />
    </Suspense>
  );
}
