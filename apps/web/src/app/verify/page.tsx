import type { Metadata } from "next";
import { Suspense } from "react";
import { PageFallback } from "../../components/PageFallback";
import { VerifyView } from "../../components/VerifyView";

export const metadata: Metadata = { title: "Check it yourself" };

export default function VerifyPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <VerifyView />
    </Suspense>
  );
}
