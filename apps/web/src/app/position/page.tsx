import type { Metadata } from "next";
import { Suspense } from "react";
import { PageFallback } from "../../components/PageFallback";
import { PositionView } from "../../components/PositionView";

export const metadata: Metadata = { title: "Position" };

export default function PositionPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <PositionView />
    </Suspense>
  );
}
