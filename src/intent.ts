/**
 * The one place this project talks to a language model.
 *
 * It exists because the regexes in src/request.ts own only the words they were
 * taught: «куди піти з дівчиною на вечір, щось нешумне» has a mood, an occasion
 * and a time of day in it, and not one of them is in the vocabulary — so the
 * person asked a precise question and got a generic week. This layer turns that
 * sentence into the options `parseRequest` already accepts, and nothing else.
 *
 * Three rules hold it in place, and all three are deliberate:
 *
 *   · it never sees an event and never searches, so it cannot invent a concert
 *     and ranking stays explainable;
 *   · it never writes preferences — it emits a Ukrainian command that
 *     `applyPrefsCommand` already understands, and that function does the
 *     writing;
 *   · without ANTHROPIC_API_KEY it is a clean no-op. `readIntent` returns null
 *     and the bot behaves exactly as it did before this file existed.
 *
 * Every null is one WARN line with the reason, so an operator reading
 * ~/.hermes/data/events-finder/logs/ can tell a missing key from a rate limit
 * from a model that answered with prose.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { EVENT_CATEGORIES, TAG_SYNONYMS } from './categories.ts';
import { cityLabel, loadConfig, resolveCity, type Config } from './config.ts';
import type { Logger } from './log.ts';
import { addDays, today } from './util.ts';

/**
 * Short-text classification at chat volume: ~200 tokens in, ~100 out, which is
 * cents per month. One constant so moving up to `claude-sonnet-5-5` — the step
 * to take if it turns out weak at mood words — is a one-line change.
 */
export const INTENT_MODEL = 'claude-haiku-5-5';

/** Dates further out than this are a hallucination, not a plan. */
const HORIZON_DAYS = 180;

/** Nobody's evening costs this much; anything above it is a decimal slip. */
const MAX_PRICE = 100_000;

/** A range label is read by a human, so it is a phrase, not a paragraph. */
const MAX_LABEL = 40;

export type Intent =
  | {
      action: 'search';
      city?: string;
      from?: string;
      to?: string;
      rangeLabel?: string;
      like?: string[];
      dislike?: string[];
      maxPrice?: number;
    }
  | { action: 'prefs'; command: string }
  | { action: 'unclear'; question: string };

export interface IntentDeps {
  /** Test seam: the suite injects this and never touches the network. */
  ask?: (system: string, text: string) => Promise<string>;
  log?: Logger;
}

/**
 * The taste words the model is allowed to use, built from the two places that
 * already define them — so adding a genre to src/categories.ts updates this
 * prompt and this validation at the same time.
 *
 * `other` is left out: it is the bucket a classifier falls into, not something
 * a person likes, and `parseRequest` throws it away anyway.
 */
const VOCABULARY: string[] = [...EVENT_CATEGORIES.filter((c) => c !== 'other'), ...Object.keys(TAG_SYNONYMS)];

/**
 * What the model is asked to send back — flat, not a union.
 *
 * The API's structured output takes one JSON schema whose root is an object, so
 * the three actions share one shape and `toIntent` picks the fields that belong
 * to the action. The keys are snake_case because that is what reads naturally
 * in a prompt; the camelCase ones are this codebase's and live on `Intent`.
 */
const ReplySchema = z.object({
  action: z.enum(['search', 'prefs', 'unclear']),
  city: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  range_label: z.string().optional(),
  like: z.array(z.string()).optional(),
  dislike: z.array(z.string()).optional(),
  max_price: z.number().optional(),
  command: z.string().optional(),
  question: z.string().optional(),
});

type Reply = z.infer<typeof ReplySchema>;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read one free-text message as search parameters, a preference command, or a
 * question back. Returns null — and never throws — when there is no API key,
 * when the call fails or times out, or when the answer does not validate.
 */
export async function readIntent(text: string, deps: IntentDeps = {}): Promise<Intent | null> {
  const log = deps.log;
  const warn = (why: string): null => {
    log?.warn(`intent: ${why}`);
    return null;
  };

  // The key is checked before `ask` is reached, injected or not: "no key" is
  // the shape this runs in for anyone who has not set one up, and a test that
  // proves the layer is off must be able to prove the call never happened.
  if (!process.env['ANTHROPIC_API_KEY']) return warn('no ANTHROPIC_API_KEY, skipping the model');

  const cfg = loadConfig();
  const base = today(cfg.timezone);
  const ask = deps.ask ?? askClaude;

  let raw: string;
  try {
    raw = await ask(systemPrompt(cfg, base), text);
  } catch (err) {
    return warn(describeFailure(err));
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return warn(`the reply was not JSON: ${raw.slice(0, 120)}`);
  }

  const parsed = ReplySchema.safeParse(json);
  if (!parsed.success) return warn(`the reply did not fit the schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`);

  return toIntent(parsed.data, base, cfg, warn);
}

/**
 * Everything the model said, checked against this project's own idea of what
 * exists. The model is a parser of sentences, not a source of truth: an unknown
 * genre, an unknown city or a price with an extra zero is dropped quietly,
 * while a date far outside the horizon kills the whole intent — a hallucinated
 * 2031 would scrape nothing and look like a source outage.
 */
function toIntent(reply: Reply, base: string, cfg: Config, warn: (why: string) => null): Intent | null {
  if (reply.action === 'prefs') {
    const command = reply.command?.trim();
    if (!command) return warn('a prefs intent with no command in it');
    return { action: 'prefs', command };
  }

  if (reply.action === 'unclear') {
    const question = reply.question?.trim();
    if (!question) return warn('an unclear intent with no question in it');
    return { action: 'unclear', question };
  }

  const intent: Intent = { action: 'search' };

  if (reply.from !== undefined || reply.to !== undefined) {
    const from = reply.from ?? reply.to;
    const to = reply.to ?? reply.from;
    if (!from || !to || !DATE_ONLY.test(from) || !DATE_ONLY.test(to)) {
      return warn(`dates that are not YYYY-MM-DD: ${reply.from} .. ${reply.to}`);
    }
    // string comparison is enough on YYYY-MM-DD, which is why this project
    // keeps dates in that shape everywhere
    if (from > to) return warn(`a range that ends before it starts: ${from} .. ${to}`);
    const horizon = addDays(base, HORIZON_DAYS);
    if (from < base || to > horizon) return warn(`a range outside ${base} .. ${horizon}: ${from} .. ${to}`);
    intent.from = from;
    intent.to = to;
  }

  const label = reply.range_label?.trim();
  if (label && label.length <= MAX_LABEL) intent.rangeLabel = label;

  const like = known(reply.like);
  if (like.length) intent.like = like;
  const dislike = known(reply.dislike);
  if (dislike.length) intent.dislike = dislike;

  if (reply.city !== undefined) {
    const key = resolveCity(reply.city, cfg);
    if (key) intent.city = key;
  }

  if (reply.max_price !== undefined) {
    const price = Math.round(reply.max_price);
    if (price > 0 && price <= MAX_PRICE) intent.maxPrice = price;
  }

  return intent;
}

/** Keep the tags that exist, drop the rest without failing the whole intent. */
function known(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter((t) => VOCABULARY.includes(t)))];
}

/**
 * The prompt, rebuilt on every call because today's date is in it.
 *
 * English on purpose — instructions to the model are not user-facing text, and
 * the Ukrainian in here is the vocabulary it has to answer with.
 */
function systemPrompt(cfg: Config, base: string): string {
  const cities = Object.keys(cfg.cities)
    .map((key) => `${key} (${cityLabel(key, cfg)})`)
    .join(', ');

  return [
    `You read one short message to an events bot in Ukraine and turn it into search parameters.`,
    `Today is ${base} in ${cfg.timezone}. Answer with JSON and nothing else.`,
    ``,
    `Pick exactly one action:`,
    `- "search": they are asking what is on. Fill in only what the message actually says.`,
    `- "prefs": they are stating a lasting taste rather than asking anything ("I never want X",`,
    `  "follow Y", "my city is Z"). Put it in "command".`,
    `- "unclear": you cannot tell what they want. Put one short question in "question".`,
    ``,
    `Fields of a search:`,
    `- "city": one of these keys, or leave it out when no city is named: ${cities}`,
    `- "from" / "to": YYYY-MM-DD, both or neither, between ${base} and ${addDays(base, HORIZON_DAYS)}.`,
    `- "range_label": that period as a person would say it in Ukrainian, a few words:`,
    `  «сьогодні», «ці вихідні», «у пʼятницю ввечері».`,
    `- "like" / "dislike": only these tags, nothing else — no invented ones, no translations:`,
    `  ${VOCABULARY.join(', ')}`,
    `- "max_price": hryvnia for one ticket, a number.`,
    ``,
    `Mood and occasion are the whole point of your job, because the bot's own rules already`,
    `read dates, budgets and genre names. A mood is not a tag: «нешумне», «спокійне», «щось`,
    `тихе» mean prefer the quiet end of the list and exclude the loud one — for example`,
    `dislike ["party", "metal", "karaoke"]. «потусити», «відірватися», «щось гучне» mean the`,
    `opposite. An occasion is a hint too: «з дівчиною на вечір» is an evening out for two, so`,
    `theatre, cinema or candlelight over a lecture. Translate the mood into the tags on the`,
    `list above; never answer with a tag that is not on it.`,
    ``,
    `The bot cannot filter by time of day, so «на вечір» or «після роботи» only tells you`,
    `which day they mean and what kind of event fits it. Do not invent a field for it.`,
    ``,
    `A "command" must be Ukrainian and phrased like one of these, which the bot already`,
    `understands: «додай джаз до улюблених», «не люблю класику», «слідкуй за Жадан і Собаки»,`,
    `«максимум 500 грн», «домашнє місто Львів».`,
    ``,
    `A "question" must be Ukrainian and one sentence.`,
  ].join('\n');
}

/**
 * The real call.
 *
 * Request parameters worth not getting wrong, in the order they bite:
 * `effort: 'low'` because Haiku 5.5 defaults to `medium` and this is
 * classification; `thinking: 'disabled'`, which is legal on this model at
 * effort `high` or below and matters because a person is waiting in a chat
 * (`budget_tokens` is a 400 here — never send it); no `temperature`, `top_p`
 * or `top_k`, each of which is a 400 on every current model; and a timeout in
 * **milliseconds**, unlike the Python SDK.
 *
 * No prompt caching in this version: the system prompt carries today's date, so
 * it changes daily anyway, and it is probably under Haiku's minimum cacheable
 * prefix. Please do not "fix" that by adding a cache_control block.
 */
async function askClaude(system: string, text: string): Promise<string> {
  const client = new Anthropic({ timeout: 8000, maxRetries: 1 });
  const res = await client.messages.create({
    model: INTENT_MODEL,
    max_tokens: 256,
    system,
    messages: [{ role: 'user', content: text }],
    output_config: { effort: 'low', format: zodOutputFormat(ReplySchema) },
    thinking: { type: 'disabled' },
  });
  return res.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
}

/** One log line per failure, most specific error class first. */
function describeFailure(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) return 'the API rate-limited us';
  if (err instanceof Anthropic.AuthenticationError) return 'the API rejected ANTHROPIC_API_KEY';
  if (err instanceof Anthropic.APIError) return `the API answered ${err.status}: ${err.message}`;
  return `the call failed: ${err instanceof Error ? err.message : String(err)}`;
}
