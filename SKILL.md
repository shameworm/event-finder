---
name: events-finder
description: Use when the user asks what is on in a Ukrainian city — concerts, stand-up, theatre, exhibitions, lectures, parties, festivals, workshops. Also use to operate the shared Telegram bot behind it: start or check the bot service, inspect or edit a user's taste, run the weekly/weekend digest, follow alerts or reminder jobs, and diagnose why someone did not get a digest. Covers Kharkiv (default), Kyiv, Lviv, Dnipro, Odesa and any city configured in config.yaml.
---

# events-finder

A Telegram bot that anyone can use, plus the CLI behind it. Each user has their
own city, taste model, digest settings and reminders, all keyed by their Telegram
chat id. Every city is scraped **once** and the result is ranked separately per
user, so a hundred subscribers cost one crawl.

**Default city: Kharkiv.** Any other configured city works on request.

**The bot speaks Ukrainian only.** Every string a user reads — the command menu,
the settings panel, digests, reminders, prices and date labels — is Ukrainian;
logs, CLI output, `/stats` and `/broadcast` stay English, because they are for whoever runs
it. The copy sits next to the code that sends it, not in a catalogue: there is
one language, so a lookup layer would buy nothing. Day names come from
`locale: uk-UA` in config.yaml and city names from each city's `label`.
Recognition stays multilingual — `src/categories.ts` matches Ukrainian, Russian
and English — so "stand-up" and "стендап" are both understood, but the reply is
always Ukrainian.

**An answer is one card you walk through.** A digest — scheduled or asked for —
is a short header plus **one card**, with the rest of the ranked list in a stash
behind it; «Далі →» and «← Назад» under the card swap the event on that same
message. Every message that does go out is recorded against the single event it
showed, which is what makes a ❤️ reaction unambiguous. Only what was shown
counts as sent, so an event still in the stash can turn up in a later digest.
Follow alerts are still one message per item. Console output
(`scripts/search.ts`) still uses the one-block digest.

## Before anything else

```bash
cd ~/.hermes/skills/events-finder
npx tsx scripts/doctor.ts          # config, secrets, database, users, source health
```

Run this first in a fresh session, after any config change, and whenever
something stops working. It exits non-zero only when something is actually
broken; warnings are normal.

## The bot

```bash
npx tsx scripts/bot.ts             # long-poll until stopped — the normal way to run it
npx tsx scripts/bot.ts --once      # drain what is waiting, then exit (cron mode)
npx tsx scripts/bot.ts --dry-run   # print replies instead of sending
```

**Only one copy may poll at a time.** Telegram hands each update to a single
`getUpdates` caller, so a second instance steals messages. Before starting one,
check nothing is already running (`pgrep -fl "scripts/bot.ts"`). In production it
belongs under a supervisor — see the README.

What users can send it: `/start` (the walkthrough — see below), `/find` (the
guided search), `/week`, `/weekend`, `/today`, `/tomorrow`,
`/saved`, `/city`, `/prefs`, `/setup`, `/settings`,
`/mute week|weekend|follows`, `/unmute`, `/reminders`, `/follow X`,
`/unfollow X`, `/stop`, `/help`, `/feedback <text>` (stored in the `feedback`
table and forwarded to the owner), and — owner only, invisible to everybody
else — `/stats` and `/broadcast <message>`, which previews and asks before it
announces anything to every user.
Anything else is treated as a preference change if it reads like one, otherwise
as a search.

Requests may be written in Ukrainian, Russian or English — that was always true
of the parser and is unchanged.

**Nobody inherits anybody's taste.** `/start` runs a six-step walkthrough —
city, liked categories, genres, dislikes, budget, follow list — and a new user's
profile is whatever they tapped, starting from empty. The step lives in
`users.stage` (`city → likes → genres → dislikes → budget → follow → NULL`);
every screen renders its ticks from the stored preferences, so `/setup` and
`/settings → 🎛 Мої смаки` reopen the same screens later to change one thing.
Only `stage = 'city'` holds someone back from the scheduled jobs: walking away
at "what's your budget?" costs them nothing. `preferences.yaml` is the
operator's own profile and the CLI's defaults — never a template for strangers.

Users who registered before the walkthrough existed are offered it once, with a
button; declining is remembered in the `state` table under
`setup_offered:<chat id>`.

Typing still works at every screen and never falls through to a search: a
sentence («не люблю класику») goes through the usual parser, a bare list
(«стендап, джаз») is read as favourites and added to whatever is already ticked,
a name at the follow step is a name, and «пропустити» moves on. Anyone left on
the earlier one-question `taste` stage is treated as being on the first screen.

**The card is a cursor, not a feed.** A fresh answer sends the header and a
single event (`bot.cards_at_once`, default 1); the rest waits in the hourly
stash behind it, along with everything already walked past (`seen`). **Далі →
(N)** and **← Назад (N)** *replace the event on the card you tapped* rather
than sending another message, so a forty-event weekend stays one message you
move through. **📋 Показати списком** on the header is the opt-in for a batch
of `bot.max_results`. The header counts the whole answer, not the card.

Telegram decides how the replacement happens: `editMessageText` for a card
without a poster, `editMessageMedia` for one with — and a *re-send plus delete*
when the step crosses between them, because a text message cannot become a
photo message or the reverse. All three paths rewrite the `messages` row, so a
❤️ on the card means the event now showing. A poster Telegram refuses falls
back to the re-send, which falls back to text, exactly as a first send does.

Every event card carries **ℹ️ Деталі · 🔖 Зберегти · Далі →** above the ⏰/👎
row. Деталі redraws the same message as the full record of what the source
gave us — and nothing it did not; 🔖 is a bookmark in the `saved` table, which
keeps the whole item, so /saved survives the thirty-minute scrape cache and
does *not* count as a delivery; Далі → hands out one more event from the stash
behind the newest answer (`lastpage:<chat id>` in the `state` table) and only
appears when there is one. A card that went out with a poster is a photo
message, so these redraws go through `editMessageCaption`, not
`editMessageText`.

`/find` is the same search for people who would rather tap than type: a
category screen, then a period screen, with the choice parked in the `state`
table under `find:<chat id>` — the bot also runs in `--once` cron mode, where
no wizard can live in a variable.

Most of that is also reachable without typing. The bot publishes `BOT_COMMANDS`
with `setMyCommands` on start-up, so Telegram autocompletes `/` and fills the ☰
menu; `/start` and `/help` carry quick-action buttons; and `/settings` is a
panel of inline buttons that toggles each digest, changes the city and shows the
taste model, rewriting itself in place on every tap. Button presses arrive as
`callback_query` updates and are handled by `handleCallback`.

## Answering a request yourself

When the user asks you directly rather than the bot, use the CLI:

```bash
npx tsx scripts/search.ts "що цікавого у Харкові на вихідних, люблю стендап та інді-рок, без класики"
```

It parses the free text (city, dates, likes, dislikes, budget), runs every
source through the shared cache, deduplicates, ranks and prints a digest grouped
by day.

| Flag | Meaning |
|---|---|
| `--city kharkiv` / `--cities kharkiv,kyiv` | override the city |
| `--from 2026-11-01 --to 2026-11-03` | override the date window |
| `--like standup,indie` / `--dislike classical` | extra taste tags for this run |
| `--max-price 800` | budget for this run |
| `--top 10` | keep only the best N |
| `--only concert.ua,karabas` / `--skip telegram` | restrict sources |
| `--pages 2` | fewer pages per source (faster, less complete) |
| `--chat ID` | act as that user (defaults to `TELEGRAM_CHAT_ID`) |
| `--new-only` | hide what that chat has already been sent |
| `--send` | deliver to that chat on Telegram |
| `--json` | raw JSON |
| `--explain` | show why each item ranked where it did |

**Trust the parser, but override it when the user was specific.** Dates it
understands: today, tonight, tomorrow, this/next weekend, this/next week, this
month, `next 3 days`, `25 жовтня`, `23-25 жовтня`, `25.10`, `2026-11-03`,
weekday names — in English, Ukrainian and Russian.

## Sources, one script each

```bash
npx tsx scripts/concertua.ts    --city kharkiv --from 2026-10-24 --to 2026-10-26
npx tsx scripts/karabas.ts      --city kharkiv --json
npx tsx scripts/kontramarka.ts  --city odesa
npx tsx scripts/venues.ts       --city kharkiv
npx tsx scripts/venues.ts       --probe https://teatr.example.ua/afisha
npx tsx scripts/telegram.ts     --city kharkiv --days 14
npx tsx scripts/websearch.ts    --city kharkiv
```

- **concert.ua** — `concert.ua/en/catalog/<slug>/<category>?page=N`, schema.org JSON-LD.
- **karabas** — `<city>.karabas.com/?page=N`, JSON-LD with venue, price range, availability.
- **kontramarka** — `<city>.kontramarka.ua/uk/<category>?page=N`, microdata via cheerio. Kyiv is on the bare domain.
- **venues** — every url under `cities.<city>.venues` in config.yaml: a theatre's
  afisha, a club, a festival programme. One request per url as written, no
  crawling and no pagination. Items are filed per site (`venue:<hostname>`), so
  /stats has a row each. Adding one is a config edit — `--probe <url>` prints
  what a page publishes, which is the check to run before suggesting it.

All three publish a poster on the very pages above — a URL on Concert.ua, an
`ImageObject` on Karabas, a `<meta itemprop="image">` on Kontramarka — so an
event carries `image` and is sent as a photo. The Telegram and websearch
sources do not: channel posts carry media as a `file_id`, which is a different
mechanism, and a search result carries no picture at all. Those stay text.
- **telegram** — public channels per city via GramJS. One shared login (the operator's), used for everyone.
- **websearch** — the two-step hand-off below.

A failing source never stops a run: it is logged and the rest continue. If a run
reports `⚠️ sources that failed`, say so rather than implying the list is complete.

A source that *throws* is the easy case. The quiet one is a scraper that stops
matching its site: 200 OK, nothing parsed, `{ ok: true, items: [] }`, and no
failure anywhere. The fan-out counts those (`src/health.ts`) and tells the owner
after three consecutive ticks where that source found nothing and others found
events in the same cities. `scripts/doctor.ts` prints the same counters — read
them before concluding a city is simply quiet.

Venue pages are the exception: a small venue with nothing on this fortnight is
indistinguishable from a page that stopped parsing, so they are counted and
shown in /stats but never alerted on one by one. Only `venues` — the collector
they share — can report an outage, and it does so when *every* configured page
came back empty while other sources found events.

### websearch needs you

Hermes has no HTTP search API, so this source borrows your `web_search` tool:

```bash
# 1. ask what to search for — one entry per city that has users
npx tsx scripts/websearch.ts --queries --city kharkiv
npx tsx scripts/follows.ts --queries                  # the names people follow

# 2. run those queries with your own web_search tool

# 3. hand the results back
npx tsx scripts/websearch.ts --ingest results.json --city kharkiv
#    or: echo "$JSON" | npx tsx scripts/websearch.ts --ingest - --city kharkiv

# 4. they are now part of every run for 7 days
npx tsx scripts/follows.ts --dry-run
```

Per result: `title` and `url` are required; `snippet`, `date`, `venue`,
`address`, `price`, `category`, `status` all help. Events with no recognisable
date are dropped.

## Scheduled jobs (they fan out to every user)

```bash
npx tsx scripts/digest.ts --week                # hourly — whoever asked for this hour/day
npx tsx scripts/digest.ts --weekend --top 5     # hourly on Thursday — weekend picks
npx tsx scripts/digest.ts --week --hour 18 --day 5 --dry-run   # rehearse one slot
npx tsx scripts/digest.ts --week --now          # ignore the schedule, send to everyone
npx tsx scripts/follows.ts                      # every 6h — new shows by people they follow
npx tsx scripts/follows.ts --queries            #   …run these first: tours are announced by name
npx tsx scripts/reminders.ts                    # every 15min — fire due ❤️ reminders
```

All of them take `--dry-run` (print, send nothing, record nothing) and
`--chat ID[,ID]` (restrict to those users — use this when testing, so you do not
message strangers). Exact cron configuration is in `cron.example.yaml`.

Each prints a one-line summary: items sent, recipients, cities, and how many of
those cities came from the cache rather than a fresh scrape.

## Looking after users

```bash
npx tsx scripts/prefs.ts --list                              # everyone registered
npx tsx scripts/prefs.ts --chat 123456789                    # one person's taste
npx tsx scripts/prefs.ts --chat 123456789 "follow Latexfauna"
npx tsx scripts/prefs.ts --defaults "add jazz to favourites"  # defaults for NEW users
```

One-off cleanup for a bot that ran before the walkthrough existed:
`npx tsx scripts/disinherit.ts` (dry run; `--yes` to write) removes from every
user the favourites, dislikes and genres that are identical to the
seed file — the ones they were handed rather than chose. It leaves the ❤️ tally
and the price cap alone.

One-off cleanup for a bot that ran when it still found places:
`npx tsx scripts/unplace.ts` (dry run; `--yes` to write) throws away the stored
items that are places — a bookmarked café has a category that no longer exists,
so it cannot be read back. Nothing breaks without it: every read already skips
what it cannot parse, counts it and logs it, so `/saved` shows four of five
bookmarks rather than erroring. Messages are trimmed rather than dropped when
only some of their items were places.

`preferences.yaml` is the operator's own profile and what the CLI falls back to;
it is not handed to new users, who build their own through the walkthrough. Live
preferences live in the database per chat id.

**Be careful with other people's data.** Only inspect or change a specific
user's preferences when the user you are talking to is asking about their own
chat, or is the bot owner. Do not quote one user's data to another, and do not
send messages to chat ids the user did not name.

## Diagnosing "I didn't get my digest"

Work down this list:

1. `npx tsx scripts/prefs.ts --list` — are they registered, and in which city?
   `[week:0]` means they muted it; `blocked` users are skipped entirely.
2. `npx tsx scripts/digest.ts --week --dry-run --chat <id>` — does the job
   produce anything for them at all?
3. If it is empty, their filters are the usual cause: `/prefs` shows dislikes and
   a max ticket price that may be dropping everything. `--explain` on
   `search.ts` lists what was filtered and why.
4. Nothing new since last time is normal — a digest only repeats an event when
   its date, price or availability changed. `--all` ignores that.
5. Check the log for the job's summary line and for `ERROR`.

## How ranking works

**An answer only contains what that person likes.** Taste is a filter, not a
nudge: everything matching nothing in their profile is dropped and counted, and
the bot says how many it hid. Scoring alone was not enough — a free event on two
ticket sites outscored a category somebody had chosen by hand, so the taste
model was invisible and looked broken.

What counts as "their thing": the tags of the request if they asked for
something specific (`стендап на вихідних` means stand-up, not everything they
have ever liked), otherwise their favourites and genres. A followed performer
always counts.

When fewer than `bot.taste_floor` (default 5) of their things are on, the next
best are added back rather than sending an almost empty list — `Ranked.toppedUp`
says how many, and the message admits it. An empty profile filters nothing, and
neither does the shared city cache (`keepOffTaste`), which is written once for
everybody and ranked per person afterwards.

Inside what survives: request-level likes count most, then favourites, then
genres. Each ❤️ on a tag adds one more point to it (`prefs.taste`, capped at
five), so a category someone keeps hearting beats one they hearted once. A
followed performer adds a large boost **and** bypasses both the dislike filter
and the budget cap. Disliked tags and over-budget items are dropped
(`--include-disliked`, `--include-expensive`, `--explain`). Sold-out, cancelled
and postponed events are kept but marked and pushed down.

**A genre is not its category.** `matchesTag`/`expandTag` only treat a tag as a
category when it *names* one. "indie" lives in the concert keyword list, so
borrowing that category made one indie genre match every gig in town — and
report "indie" as the reason for a classical symphony.

## Already-sent memory

Per user, in the `deliveries` table. An item is re-sent only when something
material changed, and the line says why, in Ukrainian: `🔁 нова дата`,
`🔁 мало квитків`, `🔁 квитки скінчилися`, `🔁 змінилася ціна`. The reasons come
out of `Store.filterUnsent` in English and are translated by `copy.CHANGE_NOTE`.

## Reminders

A user taps ❤️ on an event message (or types `нагадай`);
`scripts/bot.ts` records it and `scripts/reminders.ts` fires 1 day and 3 hours
before the start. Reminders belong to a chat, so `--cancel` needs `--chat` too.

Taking the ❤️ off cancels the reminder; the taste it taught is kept. A heart
does three things at once, in one save, which is why the model improves without
anyone typing anything:

- the event's category joins their favourites
- `prefs.taste[tag]` goes up — **every** heart, not just the first
- whoever is on stage joins their follow list, when the ticket site filled in a
  performer. A show title is never used as a name: «Вечір імпровізації» is
  nobody.

Reactions only arrive because `getUpdates` asks for `message_reaction`
(`src/telegram-api.ts`). If reminders stop appearing while replies still work,
that is the first thing to check.

## Gotchas worth knowing

- **Be polite to the sources.** The 1.5s per-host delay and the scrape cache
  (`cache.ttl_seconds`, default 30 min) are what make a shared bot acceptable.
  Do not lower them, and do not bypass `collectCity` by calling sources in a loop
  per user.
- **Rate limits.** Each user gets `bot.searches_per_hour` searches (default 20).
  On-demand searches use `bot.interactive_pages` (default 2) because somebody is
  waiting.
- A city only works if it has a section in `config.yaml`; onboarding only offers
  configured cities. If a user asks for a missing one, offer to add it.
- `telegram_channels` ships empty — that source stays quiet until the operator
  fills in channel names. Ask for them rather than inventing names.
- First GramJS use needs an interactive login: `npx tsx scripts/tg-login.ts`.
  Never run it from cron, and never print the session string.
- **Posters are never downloaded here.** `image` is handed to Telegram as a URL
  and Telegram fetches it. A URL it cannot fetch fails the whole message, so
  `deliver` re-sends that card as text and logs `poster rejected` with the URL —
  grep for that line before believing a source has stopped publishing posters.
- Logs: `~/.hermes/data/events-finder/logs/events-finder.log`.
- No build step; everything runs with `tsx`. `npm test` is offline and takes a
  couple of seconds — run it after editing anything in `src/`.
