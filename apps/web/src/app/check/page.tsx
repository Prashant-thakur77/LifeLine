import type { Metadata } from "next";
import { Suspense } from "react";
import { CheckView } from "../../components/CheckView";
import { PageFallback } from "../../components/PageFallback";

export const metadata: Metadata = { title: "Check an account" };

export default function CheckPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <CheckView />
    </Suspense>
  );
}
