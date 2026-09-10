import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves a project site from https://<user>.github.io/<repo>/,
// so `base` must match the repo name exactly. Update this if you rename
// the repo, or set it back to "/" if you deploy to a custom domain instead.
export default defineConfig({
  plugins: [react()],
  base: "/LiveLens/",
});
