import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Second Look", description: "Subscription decisions with receipts." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
