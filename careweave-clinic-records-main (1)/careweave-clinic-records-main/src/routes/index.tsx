import { createFileRoute } from "@tanstack/react-router";
import { ClinicApp } from "@/components/ClinicApp";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Clinic Records — Offline-first patient records" },
      { name: "description", content: "Register patients, record visits and view history offline. Syncs automatically when internet returns." },
      { property: "og:title", content: "Clinic Records — Offline-first patient records" },
      { property: "og:description", content: "Register patients, record visits and view history offline. Syncs automatically when internet returns." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ClinicApp,
});
