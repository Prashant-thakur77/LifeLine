import type { ReactNode } from "react";

/** Each page slides in like a new sheet laid on the stack. Movement only: the content is never hidden. */
export default function Template({ children }: { children: ReactNode }) {
  return <div className="page-in">{children}</div>;
}
