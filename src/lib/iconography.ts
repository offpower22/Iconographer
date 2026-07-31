// Reference data + matching logic. Symbol-first: every gesture, pose, object,
// animal, garment, or color in data/symbols.json has a meaning that stands on
// its own. Figure identification (e.g. "this is Saint Jerome") is a derived,
// optional signal — never the thing we're required to get right to be useful.
import data from '../../data/symbols.json';

export interface FigureNote {
  name: string;
  note: string;
  /** true for broad classes ("Saints generally") — shown as context, never suggested */
  generic?: boolean;
}

export type Tradition = 'western' | 'byzantine';

export interface Symbol {
  id: string;
  name: string;
  category: string;
  meaning: string;
  figures?: FigureNote[];
  aliases?: string[];
  /** set only when a symbol is genuinely specific to one tradition; most are unset */
  tradition?: Tradition;
}

export interface DetectedElement {
  element: string;
  location?: string;
  /** normalized bounding box [ymin, xmin, ymax, xmax] in 0..1000, per Gemini's convention */
  box?: [number, number, number, number];
}

export interface SymbolMatch {
  id: string;
  name: string;
  category: string;
  meaning: string;
  figures: FigureNote[];
  /** the raw text Gemini detected that this symbol was matched from */
  matchedElement: string;
  location?: string;
  box?: [number, number, number, number];
}

export interface FigureSuggestion {
  name: string;
  /** which matched symbols contributed to this suggestion */
  supportingSymbols: string[];
  weight: number;
}

const SYMBOLS: Symbol[] = (data as { symbols: Symbol[] }).symbols;

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Crude singularizer. The 'ss' guard matters: without it "cross" would stem to
 * "cros" while "crosses" stemmed to "cross", so the two would never meet.
 */
function stem(word: string): string {
  if (word.endsWith('ss')) return word;
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('s') && word.length > 3) return word.slice(0, -1);
  return word;
}

// Words too generic to identify a symbol on their own. A bare "robe", "bird",
// or "flower" is not an iconographic reading — the qualifier carries all the
// meaning ("red robe", "white bird", "purple flower"), so these tokens are
// ignored when scoring overlap. Exact matches are unaffected.
const STOPWORDS = new Set([
  // NOTE: 'man', 'woman', and 'child' are deliberately NOT stopwords — they are
  // load-bearing in "winged man", "man of sorrows", "woman holding a baby".
  'one', 'two', 'three', 'four', 'five', 'the', 'and', 'with', 'held', 'holding',
  'young', 'old', 'nude', 'large', 'small', 'left', 'right',
  'figure', 'gesture', 'pose',
  // generic head-nouns
  'robe', 'garment', 'cloak', 'mantle', 'dress', 'clothing', 'hat',
  'flower', 'tree', 'fruit', 'leaf', 'bird', 'animal', 'staff', 'stick'
]);

/** All stemmed tokens, in order — used for word-boundary containment. */
function tokens(s: string): string[] {
  return norm(s).split(' ').filter(Boolean).map(stem);
}

/** Meaning-bearing tokens only — used for overlap scoring. */
function significant(toks: string[]): string[] {
  return toks.filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Does `needle` appear in `hay` as a run of whole words? */
function containsSequence(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * 0 = no match, 3 = exact, 2 = strong (whole-word containment covering at least
 * half the other phrase), 1 = weak overlap.
 *
 * Containment is checked on WORD boundaries, never raw substrings: "across"
 * must not match "cross", "donkey" must not match "key", and "cephalophore"
 * must not match "halo".
 */
function matchQuality(detected: string, candidate: string): 0 | 1 | 2 | 3 {
  const dTok = tokens(detected);
  const cTok = tokens(candidate);
  if (dTok.length === 0 || cTok.length === 0) return 0;

  if (dTok.join(' ') === cTok.join(' ')) return 3;

  const dSig = significant(dTok);
  const cSig = significant(cTok);
  if (dSig.length === 0 || cSig.length === 0) return 0;

  const shared = new Set(dSig.filter((w) => cSig.includes(w)));
  if (shared.size === 0) return 0;

  // How much of the richer phrase did we actually account for? A lone shared
  // head-noun ("flower" against "small purple flower") explains too little to
  // be trusted, however it was found.
  const coverage = shared.size / Math.max(dSig.length, cSig.length);

  if (containsSequence(cTok, dTok) || containsSequence(dTok, cTok)) {
    return coverage >= 0.5 ? 2 : 1;
  }
  return coverage >= 0.5 ? 1 : 0;
}

export interface MatchResult {
  matches: SymbolMatch[];
  /**
   * Every detected phrase that resolved to a reference entry — including ones
   * whose symbol was already surfaced by an earlier phrase and so produced no
   * second card. Callers need this to report what was genuinely unrecognized:
   * judging by the cards alone would file "nimbus" under "not in reference
   * set" simply because "halo" got there first.
   */
  matchedElements: string[];
}

/**
 * Match each detected element against the symbol vocabulary directly.
 * One detected element -> at most one symbol (the closest match). No figure
 * ranking involved here, so there's no "shorter attribute list wins" bug —
 * each symbol is judged purely on its own name.
 */
export function matchSymbols(detected: DetectedElement[], detectedTradition?: Tradition): MatchResult {
  const results: SymbolMatch[] = [];
  const matchedElements: string[] = [];
  const seenIds = new Set<string>();

  for (const d of detected) {
    if (!d?.element) continue;

    const probeLen = norm(d.element).length;
    let best: Symbol | null = null;
    let bestQuality = 0;
    let bestDistance = Infinity;
    let tied = false;

    for (const sym of SYMBOLS) {
      const candidates = [sym.name, ...(sym.aliases ?? [])];
      let quality = 0;
      let distance = Infinity;
      for (const c of candidates) {
        const q = matchQuality(d.element, c);
        if (q === 0) continue;
        const dist = Math.abs(norm(c).length - probeLen);
        // Keep the best-quality alias, and among equal-quality aliases the one
        // closest in length to what was actually detected.
        if (q > quality || (q === quality && dist < distance)) {
          quality = q;
          distance = dist;
        }
      }
      if (quality === 0) continue;

      if (!best) {
        best = sym;
        bestQuality = quality;
        bestDistance = distance;
        continue;
      }

      if (quality !== bestQuality) {
        // Quality always decides outright — nothing below outranks it.
        if (quality > bestQuality) {
          best = sym;
          bestQuality = quality;
          bestDistance = distance;
          tied = false;
        }
        continue;
      }
      if (sym.id === best.id) continue;

      // Quality is tied. Tradition outranks distance here: it's a purpose-built
      // signal (does this artwork's detected style match this symbol's known
      // tradition?), where distance is only ever a rough proxy for specificity
      // based on incidental phrase length. Checking distance first would let
      // "icon blessing hand" (Greek) beat "blessing hand" (Latin) on a Western
      // painting purely because it happens to be closer in character count to
      // whatever Gemini phrased the detection as — exactly backwards.
      const symFits = detectedTradition != null && sym.tradition === detectedTradition;
      const bestFits = detectedTradition != null && best.tradition === detectedTradition;
      if (symFits && !bestFits) {
        best = sym;
        bestDistance = distance;
        tied = false;
        continue;
      }
      if (bestFits && !symFits) {
        continue; // keep current best — it matches the tradition, the challenger doesn't
      }

      // Tradition didn't disambiguate (no hint, or both/neither match) — fall
      // back to distance as before.
      if (distance < bestDistance) {
        best = sym;
        bestDistance = distance;
        tied = false;
      } else if (distance === bestDistance) {
        tied = true;
      }
    }

    // If two different symbols fit exactly as well, the detection is genuinely
    // ambiguous (a bare "bird", "robe", or "staff"). Say nothing rather than
    // pick one arbitrarily — the element still surfaces as "also detected".
    if (tied) best = null;

    if (!best) continue;

    // Recognized, whether or not it earns a card of its own.
    matchedElements.push(d.element);

    // Skip symbols already surfaced by an earlier detected element in this
    // scan — two phrases pointing at the same reference entry shouldn't
    // produce two identical cards.
    if (!seenIds.has(best.id)) {
      seenIds.add(best.id);
      results.push({
        id: best.id,
        name: best.name,
        category: best.category,
        meaning: best.meaning,
        figures: best.figures ?? [],
        matchedElement: d.element,
        location: d.location,
        box: d.box
      });
    }
  }

  return { matches: results, matchedElements };
}

/**
 * Optional secondary signal: does a cluster of matched symbols point toward
 * one particular figure or scene? A symbol that names only one figure is a
 * strong vote for it; a symbol shared across several figures (like a plain
 * "lion") is diluted across all of them, so it can't single-handedly tip the
 * result the way it could in the old figure-first scoring.
 */
export function suggestFigure(matches: SymbolMatch[]): FigureSuggestion | null {
  const scores = new Map<string, { weight: number; symbols: Set<string> }>();

  for (const m of matches) {
    if (m.figures.length === 0) continue;
    // Broad classes ("Saints generally", "Donor portraits") are useful context
    // on a card but are not an identification — never suggest them. They still
    // dilute the share, since they are genuinely part of the symbol's spread.
    const share = 1 / m.figures.length;
    for (const f of m.figures) {
      if (f.generic) continue;
      const entry = scores.get(f.name) ?? { weight: 0, symbols: new Set<string>() };
      entry.weight += share;
      entry.symbols.add(m.name);
      scores.set(f.name, entry);
    }
  }

  // Two independent symbols must agree before we name anyone. A single clue is
  // never enough, however diagnostic it looks: a lone white garment shouldn't
  // announce "the Risen Christ" over a picture of a towel on a desk.
  //
  // Eligibility is applied BEFORE choosing the winner. Ranking first and then
  // rejecting would let one ineligible high scorer suppress a well-corroborated
  // runner-up.
  let top: FigureSuggestion | null = null;
  for (const [name, entry] of scores) {
    if (entry.symbols.size < 2 || entry.weight < 0.75) continue;
    if (!top || entry.weight > top.weight) {
      top = { name, weight: Number(entry.weight.toFixed(2)), supportingSymbols: Array.from(entry.symbols) };
    }
  }

  return top;
}

export function symbolCount(): number {
  return SYMBOLS.length;
}
