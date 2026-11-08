import type { Metadata, Viewport } from "next";
import { Fraunces, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { Footer, Header } from "../components/Shell";
import { WalletProvider } from "../components/WalletProvider";
import "./globals.css";

const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", axes: ["opsz"], display: "swap" });
const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Lifeline: auto top-up for onchain perps", template: "%s · Lifeline" },
  description:
    "Lifeline watches your Hyperliquid margin every 5 seconds and tops it up from a reserve you fund from any chain, before liquidation. The vault only ever pays your own Hyperliquid address.",
  applicationName: "Lifeline",
};

export const viewport: Viewport = {
  themeColor: "#0a1117",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${plexSans.variable} ${plexMono.variable}`}>
      <body>
        <WalletProvider>
          <Header />
          <main className="mx-auto w-full max-w-6xl px-4 pt-8 sm:px-6 sm:pt-12">{children}</main>
          <Footer />
        </WalletProvider>
      </body>
    </html>
  );
}
