import type { UIStrings } from "../types";

export default {
  nav: {
    home: "ホーム",
    posts: "投稿",
    about: "紹介",
    archives: "アーカイブ",
    search: "検索",
  },
  post: {
    publishedAt: "公開日",
    updatedAt: "更新日",
    sharePostIntro: "この記事をシェア:",
    sharePostOn: "{{platform}}でシェアする",
    sharePostViaEmail: "メールでシェアする",
    tagLabel: "タグ",
    backToTop: "トップへ戻る",
    goBack: "戻る",
    editPage: "ページを編集",
    previousPost: "前の記事",
    nextPost: "次の記事",
    readingTime: "{{minutes}}分で読めます",
    tableOfContents: "目次",
  },
  pagination: {
    prev: "前へ",
    next: "次へ",
    page: "ページ",
  },
  home: {
    socialLinks: "ソーシャルリンク",
    featured: "注目の記事",
    recentPosts: "最近の記事",
    allPosts: "すべての記事",
  },
  sidebar: {
    bio: "色々作るソフトウェアエンジニア",
    navigation: "メニュー",
    categories: "カテゴリー",
    toggleSubtopics: "{{topic}}のサブトピックを表示",
  },
  about: {
    career: "経歴",
    education: "学歴",
    activities: "活動",
    outsourcing: "外注",
  },
  footer: {
    copyright: "Copyright",
    allRightsReserved: "All rights reserved.",
  },
  pages: {
    topicDesc: "「{{topic}}」のすべての記事。",

    postsTitle: "投稿",
    postsDesc: "投稿したすべての記事。",

    archivesTitle: "アーカイブ",
    archivesDesc: "アーカイブされたすべての記事。",

    searchTitle: "検索",
    searchDesc: "記事を検索する ...",
  },
  a11y: {
    skipToContent: "本文へスキップ",
    openSidebar: "サイドバーを開く",
    closeSidebar: "サイドバーを閉じる",
    toggleTheme: "テーマを切り替える",
    searchPlaceholder: "記事を検索...",
    noResults: "検索結果がありません",
    goToPreviousPage: "前のページへ",
    goToNextPage: "次のページへ",
  },
  notFound: {
    title: "404 Not Found",
    message: "ページが見つかりません",
    goHome: "ホームに戻る",
  },
} satisfies UIStrings;
