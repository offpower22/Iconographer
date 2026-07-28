// @ts-check
import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify';

// Static app shell + one on-demand serverless endpoint (src/pages/api/analyze.ts,
// which sets `export const prerender = false`). This keeps the PWA shell fully
// cacheable while the Gemini call runs as a Netlify Function. Chosen over Vercel
// because Netlify's free tier explicitly permits commercial use; Vercel's Hobby
// tier is personal/non-commercial only.
export default defineConfig({
  output: 'static',
  adapter: netlify(),
  build: {
    inlineStylesheets: 'auto'
  }
});
