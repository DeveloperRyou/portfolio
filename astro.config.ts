import {
  defineConfig,
  envField,
  fontProviders,
  svgoOptimizer,
} from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import { unified } from "@astrojs/markdown-remark";
import remarkToc from "remark-toc";
import remarkCollapse from "remark-collapse";
import rehypeCallouts from "rehype-callouts";
import {
  transformerNotationDiff,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from "@shikijs/transformers";
import { transformerFileName } from "./src/utils/transformers/fileName";
import {
  codeThemes,
  transformerCommentContrast,
} from "./src/utils/transformers/codeTheme";
import config from "./astro-paper.config";

export default defineConfig({
  site: config.site.url,
  integrations: [
    mdx(),
    sitemap({
      filter: page =>
        config.features?.showArchives !== false || !page.endsWith("/archives/"),
    }),
  ],
  i18n: {
    locales: ["en", "ko", "ja"],
    defaultLocale: "en",
    routing: {
      prefixDefaultLocale: false,
    },
  },
  markdown: {
    processor: unified({
      remarkPlugins: [
        [
          remarkToc,
          { heading: "(table[ -]of[ -])?contents?|toc|목차|目次", maxDepth: 2 },
        ],
        [remarkCollapse, { test: "Table of contents" }],
      ],
      rehypePlugins: [rehypeCallouts],
    }),
    shikiConfig: {
      themes: codeThemes,
      defaultColor: false,
      wrap: false,
      transformers: [
        transformerFileName({ style: "v2", hideDot: false }),
        transformerNotationHighlight(),
        transformerNotationWordHighlight(),
        transformerNotationDiff({ matchAlgorithm: "v3" }),
        transformerCommentContrast(),
      ],
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
  fonts: [
    {
      // Body text. Same no-generic-fallback setup as Google Sans Code
      // below, for the same reason: theme.css's ko/ja override appends
      // Noto Sans KR/JP directly after this font for CJK glyphs.
      name: "Inter",
      cssVariable: "--font-inter",
      provider: fontProviders.google(),
      fallbacks: [],
      optimizedFallbacks: false,
      weights: [400, 500, 600, 700],
      styles: ["normal", "italic"],
      formats: ["woff", "ttf"],
    },
    {
      // Code blocks, inline code and small metadata (dates) only.
      name: "Google Sans Code",
      cssVariable: "--font-google-sans-code",
      provider: fontProviders.google(),
      // No fallback baked into this variable: theme.css's ko/ja override
      // appends Noto Sans KR/JP directly after this font for CJK glyphs.
      // A generic keyword (e.g. "monospace") in between is unsafe -- on
      // Windows, the OS performs its own font-linking substitution for
      // unnamed generic fonts, silently swapping in a system CJK font
      // for Hangul/Kanji *before* the browser ever checks the next font
      // in the CSS list, so Noto Sans KR/JP never gets requested at all.
      // Named web fonts don't trigger this, only generic keywords do.
      // The default locale's own fallback is appended explicitly below
      // in theme.css instead, where it's safe (nothing CJK follows it).
      fallbacks: [],
      // Astro's default optimized fallback also picks a local system
      // font (e.g. Courier New) size-matched to this face with no
      // unicode-range, which has the same Windows font-linking risk.
      optimizedFallbacks: false,
      weights: [300, 400, 500, 600, 700],
      styles: ["normal", "italic"],
      formats: ["woff", "ttf"],
    },
    {
      name: "Noto Sans KR",
      cssVariable: "--font-noto-sans-kr",
      provider: fontProviders.google(),
      fallbacks: ["sans-serif"],
      weights: [400, 500, 600, 700],
      styles: ["normal"],
      formats: ["woff", "ttf"],
    },
    {
      name: "Noto Sans JP",
      cssVariable: "--font-noto-sans-jp",
      provider: fontProviders.google(),
      fallbacks: ["sans-serif"],
      weights: [400, 500, 600, 700],
      styles: ["normal"],
      formats: ["woff", "ttf"],
    },
  ],
  env: {
    schema: {
      PUBLIC_GOOGLE_SITE_VERIFICATION: envField.string({
        access: "public",
        context: "client",
        optional: true,
      }),
    },
  },
  experimental: {
    svgOptimizer: svgoOptimizer(),
  },
});
