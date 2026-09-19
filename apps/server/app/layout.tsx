import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LogSetu",
  description: "Open-source, self-hosted log management",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
