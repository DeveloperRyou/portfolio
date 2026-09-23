/**
 * Topic -> subtopic tree that drives the sidebar navigation and the
 * `/topics/...` routes. Posts reference it by slug via their `topic` /
 * `subtopic` frontmatter (validated in `content.config.ts`), so labels live
 * only here. Labels are English-only on purpose: the sidebar reads in
 * English on every locale.
 *
 * A topic or subtopic with no published posts is registered but hidden: it
 * gets no route and no sidebar entry until its first post lands.
 */
export type Subtopic = {
  slug: string;
  label: string;
};

export type Topic = {
  slug: string;
  label: string;
  /** Omit for a topic that lists its posts directly (e.g. outsourcing). */
  subtopics?: Subtopic[];
};

export const taxonomy: Topic[] = [
  {
    slug: "ai",
    label: "AI",
    subtopics: [
      { slug: "skills", label: "Skills" },
      {
        slug: "ai-documents",
        label: "AI Documents",
      },
      { slug: "models", label: "Models" },
      { slug: "retrospective", label: "Retrospective" },
    ],
  },
  {
    slug: "project-cloud",
    label: "Project Cloud",
    subtopics: [
      { slug: "build-your-own-cloud", label: "Build Your Own Cloud" },
    ],
  },
  {
    slug: "career",
    label: "Career",
    subtopics: [
      {
        slug: "42seoul",
        label: "42 Seoul",
      },
      {
        slug: "hanalum",
        label: "Hanalum",
      },
      {
        slug: "hire-diversity",
        label: "Hire Diversity",
      },
      { slug: "oasis", label: "OASIS" },
    ],
  },
  {
    slug: "outsourcing",
    label: "Outsourcing",
  },
];

export function getTopic(slug: string): Topic | undefined {
  return taxonomy.find(topic => topic.slug === slug);
}

export function getSubtopic(
  topicSlug: string,
  subtopicSlug: string
): Subtopic | undefined {
  return getTopic(topicSlug)?.subtopics?.find(sub => sub.slug === subtopicSlug);
}
