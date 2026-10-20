// Search settings shared by the build (scripts/build.mjs) and the page (app.js).
// The build saves a ready-made index and the page can only load it with the
// exact same options, so both sides import them from here.

// Words too common to be worth matching on.
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with',
]);

/**
 * Lowercases text and strips accents ("Café" → "cafe"). The result is always
 * the same length as the input, so the page can find a match in the folded
 * text and highlight the same character range in the original.
 */
export function fold(text) {
  if (/^[\x00-\x7f]*$/.test(text)) return text.toLowerCase();
  let out = '';
  for (const ch of text) {
    if (ch.length > 1) { out += ch; continue; } // astral chars (emoji etc.) pass through
    const f = ch.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
    out += f.length === 1 ? f : ch;
  }
  return out;
}

export const INDEX_OPTIONS = {
  // title = file name, folders = "Math Grade 3", text = every page of the PDF
  fields: ['title', 'folders', 'text'],
  processTerm(term) {
    const t = fold(term);
    return STOP_WORDS.has(t) ? null : t;
  },
  searchOptions: {
    // Folder names (subject, grade) are reliable; file titles are often generic.
    boost: { title: 2, folders: 4 },
    prefix: (term) => term.length > 2,                // "fract" finds "fractions"
    fuzzy: (term) => (term.length > 3 ? 0.2 : false), // ~1 typo per 5 letters
    combineWith: 'AND',
  },
};
