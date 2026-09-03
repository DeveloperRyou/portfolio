import { defineAstroPaperConfig } from "./src/types/config";

export default defineAstroPaperConfig({
  site: {
    url: "https://portfolio.developerryou.workers.dev/",
    title: "Developer Ryou",
    description:
      "Sungmin Ryou's dev blog — notes on the web services, homelab, and infra projects I build.",
    author: "Sungmin Ryou",
    profile: "https://github.com/DeveloperRyou",
    ogImage: "default-og.jpg",
    lang: "en",
    timezone: "Asia/Seoul",
    dir: "ltr",
  },
  posts: {
    perPage: 4,
    perIndex: 4,
    scheduledPostMargin: 15 * 60 * 1000,
  },
  features: {
    lightAndDarkMode: true,
    dynamicOgImage: true,
    showArchives: true,
    showBackButton: true,
    editPost: {
      enabled: false,
    },
    search: "pagefind",
  },
  socials: [
    { name: "github", url: "https://github.com/DeveloperRyou" },
    {
      name: "linkedin",
      url: "https://www.linkedin.com/in/sungmin-ryou-747605290/",
    },
    { name: "mail", url: "mailto:developerryou@gmail.com" },
  ],
  shareLinks: [
    { name: "x", url: "https://x.com/intent/post?url=" },
    { name: "facebook", url: "https://www.facebook.com/sharer.php?u=" },
    { name: "telegram", url: "https://t.me/share/url?url=" },
    { name: "mail", url: "mailto:?subject=See%20this%20post&body=" },
  ],
});