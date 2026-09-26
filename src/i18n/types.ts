export interface UIStrings {
  nav: {
    home: string;
    posts: string;
    about: string;
    archives: string;
    search: string;
  };
  post: {
    publishedAt: string;
    updatedAt: string;
    sharePostIntro: string;
    sharePostOn: string;
    sharePostViaEmail: string;
    tagLabel: string;
    backToTop: string;
    goBack: string;
    editPage: string;
    previousPost: string;
    nextPost: string;
    /** `{{minutes}}` is the estimated reading time in whole minutes. */
    readingTime: string;
    tableOfContents: string;
  };
  pagination: {
    prev: string;
    next: string;
    page: string;
  };
  postList: {
    sort: string;
    newest: string;
    oldest: string;
    /** Sort by topic/subtopic, then each series' `order`. */
    series: string;
    perPage: string;
    /** Page-size option that shows every post on one page. */
    all: string;
  };
  home: {
    socialLinks: string;
    featured: string;
    recentPosts: string;
    allPosts: string;
  };
  sidebar: {
    bio: string;
    navigation: string;
    categories: string;
    /** aria-label for a topic's expand/collapse button; `{{topic}}` is its label. */
    toggleSubtopics: string;
  };
  about: {
    career: string;
    education: string;
    activities: string;
    outsourcing: string;
  };
  footer: {
    copyright: string;
    allRightsReserved: string;
  };
  pages: {
    /** `{{topic}}` is the localized topic/subtopic label. */
    topicDesc: string;

    postsTitle: string;
    postsDesc: string;

    archivesTitle: string;
    archivesDesc: string;

    searchTitle: string;
    searchDesc: string;
  };
  a11y: {
    skipToContent: string;
    openSidebar: string;
    closeSidebar: string;
    toggleTheme: string;
    searchPlaceholder: string;
    noResults: string;
    goToPreviousPage: string;
    goToNextPage: string;
  };
  notFound: {
    title: string;
    message: string;
    goHome: string;
  };
}
