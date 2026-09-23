import type { CollectionEntry } from "astro:content";
import { taxonomy } from "@/taxonomy";
import { postFilter } from "./postFilter";

export type SubtopicNode = {
  slug: string;
  label: string;
  /** Route path relative to the locale root, e.g. `topics/career/oasis/`. */
  path: string;
  posts: CollectionEntry<"posts">[];
};

export type TopicNode = {
  slug: string;
  label: string;
  path: string;
  /** Every post in the topic, subtopics included. */
  posts: CollectionEntry<"posts">[];
  subtopics: SubtopicNode[];
};

/**
 * Resolves `taxonomy` against one locale's posts. Topics and subtopics with
 * no published posts are dropped, so they get neither a route nor a sidebar
 * entry. Pass posts already narrowed to a single locale.
 */
export function getTopicTree(posts: CollectionEntry<"posts">[]): TopicNode[] {
  const published = posts.filter(postFilter);

  return taxonomy
    .map(topic => {
      const topicPosts = published.filter(
        ({ data }) => data.topic === topic.slug
      );
      const subtopics = (topic.subtopics ?? [])
        .map(sub => ({
          slug: sub.slug,
          label: sub.label,
          path: `topics/${topic.slug}/${sub.slug}/`,
          posts: topicPosts.filter(({ data }) => data.subtopic === sub.slug),
        }))
        .filter(sub => sub.posts.length > 0);

      return {
        slug: topic.slug,
        label: topic.label,
        path: `topics/${topic.slug}/`,
        posts: topicPosts,
        subtopics,
      };
    })
    .filter(topic => topic.posts.length > 0);
}
