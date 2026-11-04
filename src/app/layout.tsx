import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";

import { Providers } from "@/components/providers";
import { SiteHeader } from "@/components/site-header";

import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "MoneyMaker", template: "%s · MoneyMaker" },
  description: "Find consistently profitable prediction-market traders and paper-copy them.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col">
        <Providers>
          <SiteHeader />
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">{children}</main>
          <footer className="text-muted-foreground mx-auto w-full max-w-7xl px-4 py-6 text-xs sm:px-6">
            Paper trading only. Past performance does not guarantee future results. Data from the
            public Polymarket API.
          </footer>
        </Providers>
      </body>
    </html>
  );
}
