import { defineConfig } from "fumadocs-mdx/config";

// Marketing use-case pages were removed for the internal deployment; no MDX
// collections remain. fumadocs-mdx still runs as a build step, so keep the
// (empty) config in place.
export default defineConfig({
  mdxOptions: {},
});
