import type { Metadata } from "next";
import { WaitlistView } from "../../components/WaitlistView";

export const metadata: Metadata = { title: "Join the waitlist", description: "Tell Lifeline about your trading in your own words, and take a berth for when mainnet sign-up opens." };

export default function WaitlistPage() {
  return <WaitlistView />;
}
