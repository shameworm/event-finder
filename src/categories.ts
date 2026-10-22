import type { Category } from './types.ts';
import { normText, stemText } from './util.ts';

export const EMOJI: Record<Category, string> = {
  concert: '🎸',
  standup: '🎤',
  theatre: '🎭',
  exhibition: '🖼',
  lecture: '🎓',
  party: '🪩',
  festival: '🎪',
  workshop: '🛠',
  cinema: '🎬',
  kids: '🧸',
  sport: '🏟',
  other: '✨',
  cafe: '☕️',
  bar: '🍸',
  gallery: '🎨',
  spot: '📍',
};

/**
 * Ukrainian names for the category keys, for anything a person reads — /prefs,
 * mostly. Free-text tags a user invented are shown as they typed them, so this
 * is a lookup with a fallback, not a complete map of everything in a tag list.
 */
export const CATEGORY_LABEL: Record<Category, string> = {
  concert: 'концерти',
  standup: 'стендап',
  theatre: 'театр',
  exhibition: 'виставки',
  lecture: 'лекції',
  party: 'вечірки',
  festival: 'фестивалі',
  workshop: 'майстеркласи',
  cinema: 'кіно',
  kids: 'дітям',
  sport: 'спорт',
  other: 'інше',
  cafe: 'кавʼярні',
  bar: 'бари',
  gallery: 'галереї',
  spot: 'місця',
};

/** The genre keys of TAG_SYNONYMS, for the same reason. */
const GENRE_LABEL: Record<string, string> = {
  classical: 'класика',
  opera: 'опера',
  ballet: 'балет',
  jazz: 'джаз',
  rock: 'рок',
  indie: 'інді',
  metal: 'метал',
  rap: 'реп',
  electronic: 'електроніка',
  pop: 'поп',
  folk: 'фолк',
  karaoke: 'караоке',
  tribute: 'трибют',
  candlelight: 'при свічках',
  chanson: 'шансон',
  improv: 'імпровізація',
  wine: 'вино',
  photo: 'фотографія',
  poetry: 'поезія',
};

/** A tag as a person should read it: a known key in Ukrainian, else as typed. */
export function tagLabel(tag: string): string {
  return CATEGORY_LABEL[tag as Category] ?? GENRE_LABEL[tag] ?? tag;
}

export const EVENT_CATEGORIES: Category[] = [
  'concert', 'standup', 'theatre', 'exhibition', 'lecture', 'party', 'festival', 'workshop', 'cinema', 'kids', 'sport', 'other',
];
export const PLACE_CATEGORIES: Category[] = ['cafe', 'bar', 'gallery', 'spot'];

/**
 * Specificity order, most specific first — used whenever two categories tie.
 * "СТЕНДАП КОНЦЕРТ" mentions both stand-up and concert; stand-up is the answer,
 * because "concert" is what a venue calls anything with a stage.
 */
const CLASSIFY_ORDER: Category[] = [
  'standup', 'theatre', 'exhibition', 'workshop', 'lecture', 'festival', 'party',
  'cinema', 'kids', 'sport', 'cafe', 'bar', 'gallery', 'spot', 'concert', 'other',
];

/**
 * Keywords per category, in Ukrainian / Russian / English.
 * Used for: parsing free-text requests, classifying Telegram posts and web results,
 * and matching "favourite_categories" from preferences.yaml.
 */
export const KEYWORDS: Record<Category, string[]> = {
  concert: [
    'concert', 'concerts', 'gig', 'live music', 'music', 'rock', 'indie', 'indie rock', 'jazz', 'rap', 'hip hop',
    'metal', 'punk', 'pop', 'folk', 'acoustic', 'band',
    'концерт', 'концерти', 'музика', 'рок', 'інді', 'інді рок', 'джаз', 'реп', 'хіп хоп', 'метал', 'панк', 'фолк',
    'акустика', 'гурт', 'виступ',
    'концерты', 'музыка', 'индирок', 'инди', 'джазовый',
  ],
  standup: [
    'standup', 'stand up', 'stand-up', 'comedy', 'comedian', 'open mic', 'improv', 'roast',
    'стендап', 'стенд ап', 'комедія', 'комік', 'гумор', 'імпровізація', 'відкритий мікрофон', 'жарти',
    'стендап', 'комедия', 'юмор', 'импровизация',
  ],
  theatre: [
    'theatre', 'theater', 'play', 'drama', 'opera', 'ballet', 'musical', 'puppet',
    'театр', 'вистава', 'спектакль', 'драма', 'опера', 'балет', 'мюзикл', 'лялькови',
  ],
  exhibition: [
    'exhibition', 'exhibit', 'gallery show', 'art show', 'vernissage', 'museum', 'installation', 'photo exhibition',
    'виставка', 'експозиція', 'вернісаж', 'музей', 'інсталяція', 'фотовиставка', 'артпроєкт',
    'выставка', 'экспозиция', 'вернисаж',
  ],
  lecture: [
    'lecture', 'talk', 'talks', 'seminar', 'conference', 'meetup', 'discussion', 'panel', 'reading', 'book club',
    'лекція', 'лекції', 'тальк', 'розмова', 'семінар', 'конференція', 'зустріч', 'дискусія', 'читання', 'презентація книги',
    'лекция', 'семинар', 'дискуссия', 'встреча',
  ],
  party: [
    'party', 'rave', 'club night', 'dj', 'techno', 'house', 'electronic', 'disco', 'dance floor', 'afterparty',
    'вечірка', 'рейв', 'клуб', 'діджей', 'техно', 'хаус', 'електронна', 'диско', 'танці', 'афтерпаті',
    'вечеринка', 'рэйв', 'танцы', 'электронная',
  ],
  festival: [
    'festival', 'fest', 'open air', 'street food festival', 'market', 'fair',
    'фестиваль', 'фест', 'опенейр', 'ярмарок', 'маркет',
    'фестиваль', 'ярмарка',
  ],
  workshop: [
    'workshop', 'masterclass', 'master class', 'course', 'training', 'intensive', 'lab',
    'воркшоп', 'майстерклас', 'майстер клас', 'курс', 'тренінг', 'інтенсив', 'лабораторія',
    'мастеркласс', 'мастер класс', 'тренинг',
  ],
  cinema: ['cinema', 'film', 'movie', 'screening', 'premiere', 'кіно', 'фільм', 'показ', 'прем єра', 'кино', 'фильм', 'показ'],
  kids: ['kids', 'children', 'family', 'дітям', 'діти', 'дитячи', 'родинн', 'дети', 'детски'],
  sport: ['sport', 'match', 'tournament', 'marathon', 'спорт', 'матч', 'турнір', 'марафон', 'турнир'],
  other: [],
  cafe: ['cafe', 'café', 'coffee', 'coffee shop', 'bakery', 'brunch', 'speciality coffee',
    'кафе', 'кава', "кав'ярня", 'кавярня', 'кофейня', 'пекарня', 'бранч'],
  bar: ['bar', 'pub', 'wine bar', 'cocktail bar', 'brewery', 'live music bar',
    'бар', 'паб', 'винний бар', 'коктейльний бар', 'пивоварня'],
  gallery: ['gallery', 'art space', 'studio', 'галерея', 'артпростір', 'арт простір', 'майстерня'],
  spot: ['spot', 'place', 'rooftop', 'hidden', 'unusual', 'місце', 'локація', 'дах', 'незвичайн', 'незвычайн'],
};

/** schema.org @type -> our category. */
const SCHEMA_TYPES: Record<string, Category> = {
  MusicEvent: 'concert',
  ComedyEvent: 'standup',
  TheaterEvent: 'theatre',
  DanceEvent: 'party',
  ExhibitionEvent: 'exhibition',
  ScreeningEvent: 'cinema',
  EducationEvent: 'lecture',
  LiteraryEvent: 'lecture',
  BusinessEvent: 'lecture',
  Festival: 'festival',
  ChildrensEvent: 'kids',
  SportsEvent: 'sport',
  SocialEvent: 'party',
  Event: 'other',
};

export function categoryFromSchemaType(type: unknown): Category | null {
  const t = Array.isArray(type) ? type[0] : type;
  if (typeof t !== 'string') return null;
  const key = t.split('/').pop() ?? t;
  return SCHEMA_TYPES[key] ?? null;
}

/** Site category slug -> our category. Covers concert.ua, karabas, kontramarka. */
const SLUGS: Record<string, Category> = {
  concerts: 'concert', concert: 'concert', electronic: 'party', clubs: 'party', dance: 'party',
  humor: 'standup', standup: 'standup', 'stand-up': 'standup',
  theater: 'theatre', theatre: 'theatre', filarmony: 'theatre', opera: 'theatre',
  exhibition: 'exhibition', museum: 'exhibition',
  festivals: 'festival', festival: 'festival',
  cinema: 'cinema', kinopokaz: 'cinema',
  kids: 'kids', children: 'kids', child: 'kids',
  business: 'lecture', excursions: 'lecture', excursion: 'lecture',
  sport: 'sport',
  show: 'other', other: 'other', inshe: 'other', tour: 'concert',
  'all-categories': 'other',
};

export function categoryFromSlug(slug: string): Category | null {
  return SLUGS[slug.toLowerCase()] ?? null;
}

/** Keywords, stemmed once, so classification survives Ukrainian inflection. */
const STEMMED: Record<Category, string[]> = Object.fromEntries(
  Object.entries(KEYWORDS).map(([cat, words]) => [cat, [...new Set(words.map(stemText).filter(Boolean))]]),
) as Record<Category, string[]>;

/**
 * Does a stemmed haystack contain a stemmed term?
 *
 * Whole words only — both sides are stemmed, so prefix matching would be
 * double-counting and it confuses near-identical stems ("вистав" for a play
 * vs "виставк" for an exhibition).
 */
export function containsTerm(stemmedHay: string, stemmedTerm: string): boolean {
  if (!stemmedTerm) return false;
  const hay = ` ${stemmedHay} `;
  return hay.includes(` ${stemmedTerm} `);
}

/**
 * Best-effort classification from free text (title + description).
 * Returns the category with the most keyword hits, or null.
 */
export function classify(text: string): Category | null {
  const hay = stemText(text);
  let best: Category | null = null;
  let bestScore = 0;
  for (const cat of CLASSIFY_ORDER) {
    let score = 0;
    for (const term of STEMMED[cat]) {
      if (containsTerm(hay, term)) score += term.includes(' ') ? 3 : 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  return bestScore > 0 ? best : null;
}

/** Map a user-written word ("stand-up", "класика") to a category, if it is one. */
export function categoryFromWord(word: string): Category | null {
  const n = normText(word);
  if (!n) return null;
  for (const cat of CLASSIFY_ORDER) {
    if (cat === n) return cat;
    if (KEYWORDS[cat].some((kw) => normText(kw) === n)) return cat;
  }
  return null;
}

/**
 * Cross-language synonyms for taste tags that are not categories — genres, scenes,
 * moods. Lets "no classical music" also exclude "класична музика" and "філармонія".
 */
export const TAG_SYNONYMS: Record<string, string[]> = {
  classical: ['classical', 'класична', 'класика', 'классическая', 'філармонія', 'филармония', 'symphony', 'симфон', 'chamber', 'камерн', 'organ', 'орган', 'chopin', 'шопен', 'mozart', 'моцарт', 'vivaldi', 'вівальді'],
  opera: ['opera', 'опера', 'оперн'],
  ballet: ['ballet', 'балет'],
  jazz: ['jazz', 'джаз', 'джазов'],
  rock: ['rock', 'рок', 'роковий'],
  indie: ['indie', 'інді', 'инди', 'indie rock', 'інді рок'],
  metal: ['metal', 'метал', 'хардкор', 'hardcore'],
  rap: ['rap', 'реп', 'рэп', 'hip hop', 'хіп хоп', 'хипхоп'],
  electronic: ['electronic', 'електронна', 'электронная', 'techno', 'техно', 'house', 'хаус', 'drum and bass', 'dnb'],
  pop: ['pop', 'поп', 'попмузика'],
  folk: ['folk', 'фолк', 'етно', 'этно', 'ethno'],
  karaoke: ['karaoke', 'караоке'],
  tribute: ['tribute', 'трибют', 'cover', 'кавер'],
  candlelight: ['candlelight', 'при свічках', 'при свечах', 'свічк'],
  chanson: ['chanson', 'шансон'],
  improv: ['improv', 'імпровізація', 'импровизация'],
  wine: ['wine', 'вино', 'винн'],
  photo: ['photo', 'фото', 'фотографія', 'фотовиставка'],
  poetry: ['poetry', 'поезія', 'поэзия', 'вірші'],
};

/** Expand a taste tag into every spelling worth matching. */
export function expandTag(tag: string): string[] {
  const n = normText(tag);
  const out = new Set<string>([n]);
  for (const [key, syns] of Object.entries(TAG_SYNONYMS)) {
    const all = [key, ...syns].map(normText);
    if (all.includes(n)) for (const s of all) out.add(s);
  }
  const cat = categoryFromWord(tag);
  if (cat) for (const kw of KEYWORDS[cat]) out.add(normText(kw));
  out.delete('');
  return [...out];
}

/**
 * Canonical storage form of a taste tag.
 *
 * Genre words win over categories so "jazz" stays "jazz" instead of widening
 * to "concert"; only words that really name a category ("stand-up", "theatre")
 * become category keys.
 */
export function canonicalTag(word: string): string {
  const n = normText(word);
  if (!n) return '';
  for (const [key, syns] of Object.entries(TAG_SYNONYMS)) {
    if ([key, ...syns].some((s) => normText(s) === n)) return key;
  }
  const exact = categoryFromWord(word);
  if (exact) return exact;

  // Ukrainian is inflected and people write what they say: "люблю виставки",
  // "не люблю класичну". Stem both sides so those land on the same key the
  // exact match would have found for "виставка" and "класична".
  const stemmed = stemText(n);
  for (const [key, syns] of Object.entries(TAG_SYNONYMS)) {
    if ([key, ...syns].some((s) => containsTerm(stemmed, stemText(s)))) return key;
  }
  for (const cat of CLASSIFY_ORDER) {
    if (STEMMED[cat].some((term) => containsTerm(stemmed, term))) return cat;
  }
  return word.trim();
}
