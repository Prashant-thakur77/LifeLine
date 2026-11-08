import type { Metadata } from "next";
import { StartView } from "../../components/StartView";

export const metadata: Metadata = { title: "Set up protection" };

export default function StartPage() {
  return <StartView />;
}
