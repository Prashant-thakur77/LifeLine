import type { Metadata } from "next";
import { Suspense } from "react";
import { PageFallback } from "../../components/PageFallback";
import { StartView } from "../../components/StartView";

export const metadata: Metadata = { title: "Set up protection" };

export default function StartPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <StartView />
    </Suspense>
  );
}
