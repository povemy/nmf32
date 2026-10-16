import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const jakartaSans = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NOMOFEE — Multi-vendor Marketplace",
  description:
    "NOMOFEE is a multi-vendor marketplace: discover independent storefronts, shop curated goods, and manage your own store. Built with Next.js, TypeScript, Tailwind CSS and shadcn/ui.",
  keywords: ["NOMOFEE", "marketplace", "multi-vendor", "ecommerce", "Next.js", "storefront"],
  authors: [{ name: "NOMOFEE" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "NOMOFEE — Multi-vendor Marketplace",
    description: "Discover independent storefronts and shop curated goods.",
    siteName: "NOMOFEE",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "NOMOFEE — Multi-vendor Marketplace",
    description: "Discover independent storefronts and shop curated goods.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${jakartaSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
