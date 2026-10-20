---
name: events-finder
description: Use when the user asks what is on in a Ukrainian city — concerts, stand-up, theatre, exhibitions, lectures, parties, festivals, workshops — or asks for new places (cafés, bars with live music, galleries, unusual spots). Also use to operate the shared Telegram bot behind it: start or check the bot service, inspect or edit a user's taste, run the weekly/weekend digest, follow alerts, place suggestions or reminder jobs, and diagnose why someone did not get a digest. Covers Kharkiv (default), Kyiv, Lviv, Dnipro, Odesa and any city configured in config.yaml.
---

# events-finder

A Telegram bot that anyone can use, plus the CLI behind it. Each user has their
own city, taste model, digest settings and reminders, all keyed by their Telegram
chat id. Every city is scraped **once** and the result is ranked separately per
user, so a hundred subscribers cost one crawl.

**Default city: Kharkiv.** Any other configured city works on request.

## Before anything else

```bash
cd ~/.hermes/skills/events-finder
npx tsx scripts/doctor.ts          # config, secrets, database, users, bot policy
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

What users can send it: `/start` (onboarding asks for their city), `/week`,
`/weekend`, `/today`, `/tomorrow`, `/places`, `/city`, `/prefs`, `/settings`,
`/mute week|weekend|follows|places`, `/unmute`, `/reminders`, `/follow X`,
`/unfollow X`, `/stop`, `/help`, and `/stats` (owner only). Anything else is
treated as a preference change if it reads like one, otherwise as a search.

## Answering a request yourself

When the user asks you directly rather than the bot, use the CLI:

```bash
npx tsx scripts/search.ts "what's interesting in Kharkiv this weekend, I like stand-up and indie rock, no classical music"
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
| `--kind place` | look for places instead of events |
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
npx tsx scripts/telegram.ts     --city kharkiv --days 14
npx tsx scripts/websearch.ts    --city kharkiv
```

- **concert.ua** — `concert.ua/en/catalog/<slug>/<category>?page=N`, schema.org JSON-LD.
- **karabas** — `<city>.karabas.com/?page=N`, JSON-LD with venue, price range, availability.
- **kontramarka** — `<city>.kontramarka.ua/uk/<category>?page=N`, microdata via cheerio. Kyiv is on the bare domain.
- **telegram** — public channels per city via GramJS. One shared login (the operator's), used for everyone.
- **websearch** — the two-step hand-off below.

A failing source never stops a run: it is logged and the rest continue. If a run
reports `⚠️ sources that failed`, say so rather than implying the list is complete.

### websearch needs you

Hermes has no HTTP search API, so this source borrows your `web_search` tool:

```bash
# 1. ask what to search for — one entry per city that has users
npx tsx scripts/places.ts --queries
npx tsx scripts/websearch.ts --queries --city kharkiv --kind place

# 2. run those queries with your own web_search tool

# 3. hand the results back
npx tsx scripts/websearch.ts --ingest results.json --kind place --city kharkiv
#    or: echo "$JSON" | npx tsx scripts/websearch.ts --ingest - --kind place --city kharkiv

# 4. they are now part of every run for 7 days
npx tsx scripts/places.ts --dry-run
```

Per result: `title` and `url` are required; `snippet`, `date`, `venue`,
`address`, `price`, `category`, `status` all help. Events with no recognisable
date are dropped.

## Scheduled jobs (they fan out to every user)

```bash
npx tsx scripts/digest.ts --week                # Monday 09:00 — this week, per user's city
npx tsx scripts/digest.ts --weekend --top 5     # Thursday 18:00 — weekend picks
npx tsx scripts/follows.ts                      # every 6h — new shows by people they follow
npx tsx scripts/places.ts                       # weekly — places to try
npx tsx scripts/reminders.ts                    # every 15min — fire due 🔔 reminders
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

`preferences.yaml` is only the starting point for new users; live preferences
live in the database per chat id. `follow` and `watch_cities` are never copied
from the defaults — they are personal.

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

Request-level likes count most, then favourites, then interests. A followed
performer adds a large boost **and** bypasses both the dislike filter and the
budget cap. Disliked tags and over-budget items are dropped by default
(`--include-disliked`, `--include-expensive`, `--explain`). Sold-out, cancelled
and postponed events are kept but marked and pushed down.

## Already-sent memory

Per user, in the `deliveries` table. An item is re-sent only when something
material changed, and the line says why: `🔁 new date`, `🔁 few tickets left`,
`🔁 sold out`, `🔁 price changed`.

## Reminders

A user replies `🔔` to an event (or `🔔 3` for the third line of a digest);
`scripts/bot.ts` records it and `scripts/reminders.ts` fires 1 day and 3 hours
before the start. Reminders belong to a chat, so `--cancel` needs `--chat` too.

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
- Logs: `~/.hermes/data/events-finder/logs/events-finder.log`.
- No build step; everything runs with `tsx`. `npm test` is offline and takes a
  couple of seconds — run it after editing anything in `src/`.
