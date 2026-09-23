// Rough reading-time estimate for a post's raw markdown body. Latin text
// is counted in words, Hangul/Kana/Kanji in characters, since CJK prose
// has no spaces to split words on.
const WORDS_PER_MINUTE = 230;
const CJK_CHARS_PER_MINUTE = 500;

const CJK_CHAR = /[぀-ヿ㐀-鿿가-힯]/g;

export function getReadingMinutes(body: string | undefined): number {
  const text = (body ?? "")
    .replace(/```[\s\S]*?```/g, " ") // fenced code isn't read line by line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1"); // keep link text, drop URLs

  const cjkChars = text.match(CJK_CHAR)?.length ?? 0;
  const words = text
    .replace(CJK_CHAR, " ")
    .split(/\s+/)
    .filter(word => /\w/.test(word)).length;

  const minutes = words / WORDS_PER_MINUTE + cjkChars / CJK_CHARS_PER_MINUTE;
  return Math.max(1, Math.round(minutes));
}
