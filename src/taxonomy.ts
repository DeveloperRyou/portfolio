/**
 * Topic -> subtopic tree that drives the sidebar navigation and the
 * `/topics/...` routes. Posts reference it by slug via their `topic` /
 * `subtopic` frontmatter (validated in `content.config.ts`), so labels and
 * their translations live only here.
 *
 * A topic or subtopic with no published posts is registered but hidden: it
 * gets no route and no sidebar entry until its first post lands.
 */
export type LocalizedLabel = Record<"en" | "ko" | "ja", string>;

export type Subtopic = {
  slug: string;
  label: LocalizedLabel;
};

export type Topic = {
  slug: string;
  label: LocalizedLabel;
  /** Omit for a topic that lists its posts directly (e.g. outsourcing). */
  subtopics?: Subtopic[];
};

export const taxonomy: Topic[] = [
  {
    slug: "ai",
    label: { en: "AI", ko: "AI", ja: "AI" },
    subtopics: [
      { slug: "skills", label: { en: "Skills", ko: "스킬", ja: "スキル" } },
      {
        slug: "ai-documents",
        label: { en: "AI Documents", ko: "AI 문서", ja: "AIドキュメント" },
      },
    ],
  },
  {
    slug: "career",
    label: { en: "Career", ko: "커리어", ja: "キャリア" },
    subtopics: [
      {
        slug: "42seoul",
        label: { en: "42 Seoul", ko: "42 서울", ja: "42 Seoul" },
      },
      {
        slug: "hanalum",
        label: { en: "Hanalum", ko: "Hanalum", ja: "Hanalum" },
      },
      {
        slug: "hire-diversity",
        label: {
          en: "Hire Diversity",
          ko: "Hire Diversity",
          ja: "Hire Diversity",
        },
      },
      { slug: "oasis", label: { en: "OASIS", ko: "OASIS", ja: "OASIS" } },
    ],
  },
  {
    slug: "outsourcing",
    label: { en: "Outsourcing", ko: "외주", ja: "外注" },
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

/** Picks a label's translation, falling back to English for unknown locales. */
export function localizeLabel(label: LocalizedLabel, locale: string): string {
  return label[locale as keyof LocalizedLabel] ?? label.en;
}
