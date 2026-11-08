import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono, Martian_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { Footer, Header } from "../components/Shell";
import { WalletProvider } from "../components/WalletProvider";
import "./globals.css";

const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap", preload: false });
// One poster grotesk at every width, from condensed headlines to body text; an instrument face for readouts.
const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo", display: "swap" });
const readout = Martian_Mono({ subsets: ["latin"], axes: ["wdth"], variable: "--font-martian", display: "swap", preload: false });

export const metadata: Metadata = {
  title: { default: "Lifeline: auto top-up for onchain perps", template: "%s · Lifeline" },
  description:
    "Lifeline watches your Hyperliquid margin every 5 seconds and tops it up from a reserve you fund from any chain, before liquidation. The vault only ever pays your own Hyperliquid address.",
  applicationName: "Lifeline",
};

export const viewport: Viewport = {
  themeColor: "#fff7ea",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable} ${readout.variable}`}>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:bg-paper focus:px-3 focus:py-2 focus:text-[14px] focus:font-semibold focus:text-ink"
        >
          Skip to content
        </a>
        <WalletProvider>
          <Header />
          <main id="main" className="mx-auto w-full max-w-6xl px-4 pt-8 sm:px-6 sm:pt-12">
            {children}
          </main>
          <Footer />
        </WalletProvider>
      </body>
    </html>
  );
}
