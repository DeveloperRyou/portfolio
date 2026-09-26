import type { CollectionEntry } from "astro:content";
import { taxonomy } from "@/taxonomy";

type Post = CollectionEntry<"posts">;

/**
 * Reading order within a subtopic: posts with an `order` come first, by
 * ascending `order`; the rest follow oldest-first by `pubDatetime`.
 * `modDatetime` is ignored so revising an earlier episode never moves it.
 */
export function compareSeriesOrder(a: Post, b: Post) {
  const ao = a.data.order ?? Infinity;
  const bo = b.data.order ?? Infinity;
  if (ao !== bo) return ao - bo;
  return a.data.pubDatetime.getTime() - b.data.pubDatetime.getTime();
}

/** A post's topic/subtopic position in `taxonomy`; untaxonomized sort last. */
function taxonomyRank({ data }: Post): [number, number] {
  const topicIndex = taxonomy.findIndex(t => t.slug === data.topic);
  if (topicIndex === -1) return [Infinity, Infinity];
  const subIndex = (taxonomy[topicIndex].subtopics ?? []).findIndex(
    s => s.slug === data.subtopic
  );
  return [topicIndex, subIndex === -1 ? Infinity : subIndex];
}

/**
 * Site-wide series order for the all-posts list: grouped by topic, then
 * subtopic (both in `taxonomy` order), then `compareSeriesOrder` within a
 * group -- so each series reads from its first episode.
 */
export function compareSiteSeriesOrder(a: Post, b: Post) {
  const [at, as] = taxonomyRank(a);
  const [bt, bs] = taxonomyRank(b);
  if (at !== bt) return at === Infinity ? 1 : bt === Infinity ? -1 : at - bt;
  if (as !== bs) return as === Infinity ? 1 : bs === Infinity ? -1 : as - bs;
  return compareSeriesOrder(a, b);
}

export type AdjacentPost = {
  id: string;
  title: string;
  filePath: string | undefined;
} | null;

const toAdjacent = (post: Post | undefined): AdjacentPost =>
  post
    ? { id: post.id, title: post.data.title, filePath: post.filePath }
    : null;

/**
 * Prev/next links for a post detail page. A post with `order` steps through
 * its subtopic in series order; any other post keeps the site-wide
 * newest-first list, where "prev" is the next-older post.
 *
 * @param sortedPosts output of `getSortedPosts` (newest-first) for one locale
 */
export function getAdjacentPosts(post: Post, sortedPosts: Post[]) {
  if (post.data.order != null && post.data.subtopic) {
    const series = sortedPosts
      .filter(
        p =>
          p.data.topic === post.data.topic &&
          p.data.subtopic === post.data.subtopic
      )
      .sort(compareSeriesOrder);
    const index = series.indexOf(post);
    return {
      prevPost: toAdjacent(series[index - 1]),
      nextPost: toAdjacent(series[index + 1]),
    };
  }

  const index = sortedPosts.indexOf(post);
  return {
    prevPost: toAdjacent(sortedPosts[index + 1]),
    nextPost: toAdjacent(sortedPosts[index - 1]),
  };
}
