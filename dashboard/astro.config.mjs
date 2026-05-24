import { defineConfig } from "astro/config";
import preact from "@astrojs/preact";

// @xyflow/react ships React-only. Aliasing react / react-dom to preact/compat
// (the standard Preact shim) lets us pull in @xyflow/react without dragging
// in 130 KB of full React. The @astrojs/preact `compat: true` flag turns on
// preact/compat at the Astro layer; the Vite alias block does the same at
// the bundler layer for direct imports from .tsx components.
export default defineConfig({
  output: "static",
  outDir: "./dist",
  integrations: [preact({ compat: true })],
  vite: {
    resolve: {
      alias: {
        react: "preact/compat",
        "react-dom": "preact/compat",
        "react/jsx-runtime": "preact/jsx-runtime",
      },
    },
  },
});
