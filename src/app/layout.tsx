import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { themeScript } from "@/components/theme-script";
import { brand } from "@/lib/brand";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: brand.name, template: `%s · ${brand.name}` },
  icons: { icon: brand.icon },
  description: "Domain lifecycle and reputation for cold email infrastructure",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {children}
        <Toaster position="bottom-right" closeButton={false} gap={8} offset={20} />
      </body>
    </html>
  );
}
