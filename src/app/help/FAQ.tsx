"use client";

import Link from "next/link";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";

const FAQ_ITEMS = [
  {
    value: "free",
    question: "Is mukoko weather free?",
    answer: (
      <p>
        Yes, completely free. No account, registration, or payment needed. We believe weather
        information is a public good.
      </p>
    ),
  },
  {
    value: "accuracy",
    question: "How accurate is the weather data?",
    answer: (
      <p>
        Weather data comes from Tomorrow.io and Open-Meteo, which aggregate global weather models.
        Short-range forecasts (1-3 days) are generally very reliable. Longer-range forecasts (4-7
        days) should be used as general guidance. For life-critical decisions, always consult your
        local meteorological service.
      </p>
    ),
  },
  {
    value: "privacy",
    question: "Do you collect my personal data?",
    answer: (
      <p>
        We use Google Analytics for anonymised usage statistics (page views, visitor counts). We
        don&apos;t use advertising pixels or fingerprinting. If you use the location feature, your
        coordinates are only used to find the nearest weather location. See our{" "}
        <Link href="/privacy" className="text-primary underline">Privacy Policy</Link> for full details.
      </p>
    ),
  },
  {
    value: "location",
    question: "Why can't I find my location?",
    answer: (
      <p>
        We cover locations across Zimbabwe, ASEAN countries, and other developing regions — with
        more being added by the community. If your area isn&apos;t listed, try using the
        &quot;Use my location&quot; feature — if you&apos;re in a supported region, a new
        location will be created automatically. You can also search for a location by name in the
        My Weather modal.
      </p>
    ),
  },
  {
    value: "ai",
    question: "What does the AI summary do?",
    answer: (
      <p>
        Our AI assistant (Shamwari Weather) generates a brief, contextual weather summary
        with practical advice. For farming areas, you&apos;ll get crop-related tips. For tourism
        spots, outdoor activity guidance. For mining areas, safety considerations. Summaries are
        refreshed periodically and cached for performance.
      </p>
    ),
  },
  {
    value: "offline",
    question: "Does it work offline?",
    answer: (
      <p>
        mukoko weather is a PWA (Progressive Web App) and can be installed on your device. However,
        weather data requires an internet connection to fetch the latest conditions. Previously loaded
        pages may be available from your browser cache.
      </p>
    ),
  },
  {
    value: "who",
    question: "Who built mukoko weather?",
    answer: (
      <p>
        mukoko weather is a product of Mukoko Africa, a division of Nyuchi Africa (PVT) Ltd. It is
        developed and maintained by Nyuchi Web Services. Learn more on our{" "}
        <Link href="/about" className="text-primary underline">About page</Link>.
      </p>
    ),
  },
];

export function FAQ() {
  return (
    <Accordion type="single" collapsible className="w-full">
      {FAQ_ITEMS.map((item) => (
        <AccordionItem key={item.value} value={item.value}>
          <AccordionTrigger>{item.question}</AccordionTrigger>
          <AccordionContent>{item.answer}</AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
