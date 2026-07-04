import type { MetadataRoute } from "next";

// Internal deployment — keep crawlers out entirely.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        disallow: "/",
      },
    ],
  };
}
