import type { UIStrings } from "../types";

export default {
  nav: {
    home: "ホーム",
    posts: "投稿",
    tags: "タグ",
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
  footer: {
    copyright: "Copyright",
    allRightsReserved: "All rights reserved.",
  },
  pages: {
    tagTitle: "タグ",
    tagDesc: "このタグが付いたすべての記事",

    tagsTitle: "タグ",
    tagsDesc: "投稿で使われているすべてのタグ。",

    postsTitle: "投稿",
    postsDesc: "投稿したすべての記事。",

    archivesTitle: "アーカイブ",
    archivesDesc: "アーカイブされたすべての記事。",

    searchTitle: "検索",
    searchDesc: "記事を検索する ...",
  },
  a11y: {
    skipToContent: "本文へスキップ",
    openMenu: "メニューを開く",
    closeMenu: "メニューを閉じる",
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
