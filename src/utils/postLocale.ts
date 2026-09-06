import type { CollectionEntry } from "astro:content";
import config from "@/config";

/**
 * Filename suffix (hyphen, not dot -- see `about-ko.md`) that marks a post
 * as belonging to a non-default locale. The default locale (`config.site.lang`)
 * has no suffix.
 */
const LOCALE_SUFFIXES: Record<string, string> = {
  ko: "-ko",
  ja: "-ja",
};

/** Locale a post entry belongs to, derived from its id's filename suffix. */
export function getPostLocale(id: string): string {
  for (const [locale, suffix] of Object.entries(LOCALE_SUFFIXES)) {
    if (id.endsWith(suffix)) return locale;
  }
  return config.site.lang;
}

/** Strips a post id's locale suffix so translated variants share one canonical slug. */
export function stripPostLocaleSuffix(id: string): string {
  for (const suffix of Object.values(LOCALE_SUFFIXES)) {
    if (id.endsWith(suffix)) return id.slice(0, -suffix.length);
  }
  return id;
}

/** Filters a post collection down to the entries belonging to one locale. */
export function getPostsByLocale<T extends CollectionEntry<"posts">>(
  posts: T[],
  locale: string
): T[] {
  return posts.filter(post => getPostLocale(post.id) === locale);
}
