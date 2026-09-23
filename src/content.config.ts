import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { glob } from "astro/loaders";
import config from "@/config";
import { getSubtopic, getTopic } from "@/taxonomy";

export const BLOG_PATH = "src/content/posts";

const posts = defineCollection({
  loader: glob({ pattern: "**/[^_]*.{md,mdx}", base: `./${BLOG_PATH}` }),
  schema: ({ image }) =>
    z
      .object({
        author: z.string().default(config.site.author),
        pubDatetime: z.date(),
        modDatetime: z.date().optional().nullable(),
        title: z.string(),
        featured: z.boolean().optional(),
        draft: z.boolean().optional(),
        /** Sidebar navigation: slugs from `src/taxonomy.ts`, checked below. */
        topic: z.string(),
        subtopic: z.string().optional(),
        /** Free keyword chips only; not used for navigation. */
        tags: z.array(z.string()).default(["others"]),
        ogImage: image().or(z.string()).optional(),
        /** Thumbnail shown on post list cards. Plain /public path, not processed by Astro's image pipeline. */
        coverImage: z.string().optional(),
        description: z.string(),
        canonicalURL: z.string().optional(),
        hideEditPost: z.boolean().optional(),
        timezone: z.string().optional(),
      })
      .superRefine(({ topic, subtopic }, ctx) => {
        // No test suite here, so a typo'd slug has to fail the build instead.
        if (!getTopic(topic)) {
          ctx.addIssue({
            code: "custom",
            path: ["topic"],
            message: `Unknown topic "${topic}" -- register it in src/taxonomy.ts`,
          });
        } else if (subtopic && !getSubtopic(topic, subtopic)) {
          ctx.addIssue({
            code: "custom",
            path: ["subtopic"],
            message: `Unknown subtopic "${subtopic}" under topic "${topic}" -- register it in src/taxonomy.ts`,
          });
        }
      }),
});

const timelineEntry = z.object({
  org: z.string(),
  location: z.string().optional(),
  role: z.string(),
  start: z.string(),
  end: z.string(),
  /** Small badge shown next to the org name, e.g. "Company" vs "Project". */
  label: z.string().optional(),
});

/** A timeline entry rendered as a clickable card with a thumbnail (see `outsourcing`). */
const projectCardEntry = timelineEntry.extend({
  thumbnail: z.string(),
  link: z.string(),
});

const pages = defineCollection({
  loader: glob({ pattern: "**/[^_]*.{md,mdx}", base: "./src/content/pages" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    ogImage: z.string().optional(),
    canonicalURL: z.string().optional(),
    /** Structured career/education timeline, rendered by the About page's Timeline component instead of markdown prose. */
    career: z.array(timelineEntry).optional(),
    education: z.array(timelineEntry).optional(),
    /** Community/cohort activities (bootcamps etc.), kept separate from paid work in `career`. */
    activities: z.array(timelineEntry).optional(),
    /** Freelance/contract-for-hire projects, kept separate from `career`. Rendered as clickable thumbnail cards. */
    outsourcing: z.array(projectCardEntry).optional(),
    /** Tech-stack badges shown on the About page, grouped into labeled rows. */
    techStack: z
      .array(z.object({ label: z.string(), items: z.array(z.string()) }))
      .optional(),
  }),
});

export const collections = { posts, pages };
