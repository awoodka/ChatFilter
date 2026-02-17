import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import AppNavbar from "./_components/AppNavbar";
import LiveSnapshotRouteGuard from "./_components/LiveSnapshotRouteGuard";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ChatFilter Dashboard",
  description: "Twitch-style dashboard for chat filtering and evaluation",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <LiveSnapshotRouteGuard />
        <AppNavbar />
        <main>{children}</main>
      </body>
    </html>
  );
}
