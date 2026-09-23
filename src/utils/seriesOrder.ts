import type { CollectionEntry } from "astro:content";

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
