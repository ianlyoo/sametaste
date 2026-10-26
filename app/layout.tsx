import type { Metadata, Viewport } from "next";
import { Caveat, IBM_Plex_Mono, Instrument_Sans } from "next/font/google";
import "./globals.css";

// Self-hosted at build. The scene's canvas text reads these via
// getComputedStyle(document.documentElement).getPropertyValue("--font-…").
const mono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "600"] });
const pen = Caveat({ variable: "--font-caveat", subsets: ["latin"] });
const sans = Instrument_Sans({ variable: "--font-instrument", subsets: ["latin"] });

// the share image is the static app/opengraph-image.jpg (and twitter-image.jpg): the counter at the Swaps frame, from the live recording
export const metadata: Metadata = {
  metadataBase: new URL("https://qloo-sametaste.vercel.app"),
  title: "SameTaste",
  description: "Your card statement, read as taste. Swaps that keep it and spend less, checked on Qloo.",
};

export const viewport: Viewport = {
  themeColor: "#e8e2d6",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${mono.variable} ${pen.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
