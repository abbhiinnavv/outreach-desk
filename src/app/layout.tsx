import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { isDemo } from "@/lib/demo";

export const metadata: Metadata = { title: "Outreach Desk", description: "Find the right firms, write the right email, send only what you approve." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/" className="brand">Outreach Desk</Link>
          <span className="step">Step 6 of 6 · Funnel</span>
        </header>
        {isDemo() && <div className="demo-banner">Public demo with fictional companies. Crawling, AI calls and sending are switched off here. The code does all of it when run on a computer.</div>}
        <main>{children}</main>
      </body>
    </html>
  );
}
