import type { Metadata } from "next";
import { Suspense } from "react";
import { AttackLabView } from "../../components/AttackLabView";
import { PageFallback } from "../../components/PageFallback";

export const metadata: Metadata = { title: "Rob the vault" };

export default function AttackPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <AttackLabView />
    </Suspense>
  );
}
