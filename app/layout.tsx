import type { Metadata } from "next";
import type { ReactNode } from "react";
import { THEME_SCRIPT } from "@/lib/theme";

import "dialkit/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Painterly",
  description: "Apply the Lukis painterly shader to a local image.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="min-h-full" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="m-0 min-h-dvh min-w-80">{children}</body>
    </html>
  );
}
