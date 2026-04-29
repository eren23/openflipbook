import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://openflipbook.dev";
const SITE_NAME = "openflipbook";
const DESCRIPTION =
  "Open-source flipbook.page clone — every page is an AI-generated illustration, click anywhere to explore deeper. Next.js + FastAPI + Modal. BYO keys.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "openflipbook — image-is-the-UI endless canvas",
    template: "%s · openflipbook",
  },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    "openflipbook",
    "flipbook.page",
    "AI image generation",
    "infinite canvas",
    "vision model",
    "nano-banana",
    "Gemini 2.5 Flash Image",
    "Qwen 2.5 VL",
    "LTX video",
    "click-to-explore",
    "BYO keys",
    "self-hosted AI",
  ],
  authors: [{ name: "Eren Akbulut", url: "https://github.com/eren23" }],
  creator: "Eren Akbulut",
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: "openflipbook — image-is-the-UI endless canvas",
    description: DESCRIPTION,
    url: SITE_URL,
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "openflipbook — tap any region of an AI-generated page to explore deeper.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "openflipbook — image-is-the-UI endless canvas",
    description: DESCRIPTION,
    creator: "@eren23",
    images: ["/og.png"],
  },
  alternates: {
    canonical: SITE_URL,
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Comic+Neue:wght@400;700&family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap"
          rel="stylesheet"
        />
        <script src="/theme-init.js" />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
