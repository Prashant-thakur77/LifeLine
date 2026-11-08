import { Skeleton } from "./ui";

/** What a page shows while it reads its query string, before any data. */
export function PageFallback() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-10 w-72 max-w-full" />
      <Skeleton className="mt-4 h-72" />
    </div>
  );
}
