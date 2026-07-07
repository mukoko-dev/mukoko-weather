import type { Metadata } from "next";
import { Noto_Sans, Noto_Serif, JetBrains_Mono } from "next/font/google";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import { ThemeProvider } from "@/components/theme-provider";
import { MineralsStripe } from "@/components/MineralsStripe";
import { NyuchiHeader } from "@/components/shell/nyuchi-header";
import { NyuchiFooter } from "@/components/shell/nyuchi-footer";
import "./globals.css";

const notoSans = Noto_Sans({
  subsets: ["latin"],
  variable: "--font-noto-sans",
});
const notoSerif = Noto_Serif({
  subsets: ["latin"],
  variable: "--font-noto-serif",
});
const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "mukoko weather stations — Console",
  description:
    "Register community weather stations, connect station hardware, and log manual readings for the mukoko weather network.",
  robots: { index: false },
};

const NAV_ITEMS = [
  {
    label: "Guide",
    href: "https://docs.nyuchi.com/mukoko-weather/weather-stations/",
    external: true,
  },
  {
    label: "weather.mukoko.com",
    href: "https://weather.mukoko.com",
    external: true,
  },
];

const FOOTER_SECTIONS = [
  {
    title: "Network",
    links: [
      {
        label: "mukoko weather",
        href: "https://weather.mukoko.com",
        external: true,
      },
      {
        label: "Explore locations",
        href: "https://weather.mukoko.com/explore",
        external: true,
      },
      {
        label: "System status",
        href: "https://weather.mukoko.com/status",
        external: true,
      },
    ],
  },
  {
    title: "Guides",
    links: [
      {
        label: "Weather stations guide",
        href: "https://docs.nyuchi.com/mukoko-weather/weather-stations/",
        external: true,
      },
      {
        label: "User guide",
        href: "https://docs.nyuchi.com/mukoko-weather/user-guide/",
        external: true,
      },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Nyuchi Africa", href: "https://nyuchi.com", external: true },
      { label: "Support", href: "mailto:support@mukoko.com" },
      {
        label: "Privacy",
        href: "https://weather.mukoko.com/privacy",
        external: true,
      },
    ],
  },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${notoSans.variable} ${notoSerif.variable} ${jetBrainsMono.variable}`}
    >
      <body className="flex min-h-dvh flex-col">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <MineralsStripe />
          <AuthKitProvider>
            <NyuchiHeader appName="weather stations" navItems={NAV_ITEMS} />
            <div className="flex-1">{children}</div>
            <NyuchiFooter
              sections={FOOTER_SECTIONS}
              companyName="Mukoko Africa — a division of Nyuchi Africa (PVT) Ltd"
              tagline="Ndiri nekuti tiri."
            />
          </AuthKitProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
