import type { Metadata } from "next";
import { FundView } from "../../components/FundView";

export const metadata: Metadata = { title: "Fund your reserve" };

export default function FundPage() {
  return <FundView />;
}
