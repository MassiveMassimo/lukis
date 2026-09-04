import type { Metadata } from "next";
import type { ReactNode } from "react";

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
    <html lang="en" className="dark min-h-full">
      <body className="m-0 min-h-dvh min-w-80">{children}</body>
    </html>
  );
}
