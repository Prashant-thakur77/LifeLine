import type { Metadata } from "next";
import { Suspense } from "react";
import { PageFallback } from "../../components/PageFallback";
import { TelegramView } from "../../components/TelegramView";

export const metadata: Metadata = { title: "Telegram alerts" };

export default function TelegramPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <TelegramView />
    </Suspense>
  );
}
