# events-finder

A Telegram bot — and the Hermes Agent skill behind it — that finds events and
places in Ukrainian cities, ranks them against each user's taste, and sends
personalised digests, alerts and reminders.

- **Events**: concerts, stand-up, theatre, exhibitions, lectures, parties, festivals, workshops
- **Places**: new cafés, bars with live music, galleries, unusual spots
- **Sources**: Concert.ua, Karabas, Kontramarka, Telegram channels (GramJS), web search
- **Cities**: Kharkiv (default), Kyiv, Lviv, Dnipro, Odesa, Ivano-Frankivsk — add any
- **Multi-user**: every person gets their own city, taste, delivery hour and reminders
- **Ukrainian**: the bot speaks Ukrainian only; it still understands requests typed in Russian or English
- **One card you walk through**, digests included — one message per event shown, so a ❤️ on it means exactly that event

TypeScript on Node 20+, run directly with `tsx` — no build step.

## How it works

```
                   ┌──────────── one scrape per city, per window ───────────┐
Concert.ua ─┐      │                                                       │
Karabas ────┼──► pipeline ──► dedupe ──► scrape cache (30 min, SQLite/PG) ──┤
Kontramarka ┤                                                              │
Telegram ───┤                                                              ▼
web search ─┘                                            rank per user (their taste)
                                                                     │
                                                 ┌───────────────────┼───────────────────┐
                                                 ▼                   ▼                   ▼
                                           user A digest       user B digest       user C digest
                                                 │                   │                   │
                                     header + ONE card, the rest in a stash behind it
                                     («Далі →» walks it; ❤️ on the card means that event)
```

The cache is the point: 200 people in Kharkiv asking about the same weekend cost
**one** crawl of each site, not 200 — and two of them asking at the same second
share the crawl that is already running. (The key includes how many pages were
asked for, so a quick chat search never stands in for a deeper digest.) Ranking, filtering and "already sent"
happen per user afterwards — and filtering means it: an answer holds what that
person likes, not everything that is on (see §Taste).

---

## 1. Install

```bash
mkdir -p ~/.hermes/skills
git clone <this repo> ~/.hermes/skills/events-finder
cd ~/.hermes/skills/events-finder

node --version          # must be v20 or newer
npm install
```

`npm install` builds one native module (`better-sqlite3`). If it fails, install
Xcode command line tools (`xcode-select --install` on macOS) or use Postgres
instead (§4).

## 2. Configure

```bash
cp config.example.yaml config.yaml
cp preferences.example.yaml preferences.yaml
```

- **`config.yaml`** — sites, cities, politeness, bot policy and cache TTL. An
  unknown key is rejected with the file name and the key, rather than falling
  back to a default you did not ask for. One
  section per city with the Concert.ua slug, the Karabas and Kontramarka
  subdomains, Telegram channels and place-search queries. All commented.
- **`preferences.yaml`** — **your own** taste model, used by the CLI. New bot
  users inherit none of it: `/start` walks them through building their own with
  buttons, and their live preferences live in the database per chat id.

Both are gitignored; only the `*.example.yaml` versions are committed.

### Bot policy

```yaml
bot:
  public: true             # false = only chat ids in `allowlist` may use it
  allowlist: []
  searches_per_hour: 20    # per user — an on-demand search can trigger a scrape
  cards_at_once: 1         # cards sent straight away; "Далі →" walks the rest
  max_results: 10          # how many "📋 Показати списком" hands out in one go
  interactive_pages: 2     # pages per source while someone waits for a reply
  send_delay_ms: 60        # pause between users when fanning out a digest
  message_delay_ms: 400    # pause between the messages of one digest

cache:
  ttl_seconds: 1800        # one scrape per city serves everyone for this long
```

**An answer is one card you walk through — and so is a digest.** A busy weekend
can rank forty events, and forty messages is forty notifications in a chat
nobody can scroll back through. So the first card goes out with the header —
which counts the whole answer, not the card — and everything else waits in the
stash behind it. **Далі → (37)** and **← Назад (3)** under the card swap the
event *on that same message*, so the chat holds one card however far you walk.
**📋 Показати списком** on the header is the opt-in for a batch of `max_results`
at a time. Nothing is re-scraped or re-ranked by any of it: they all read the
tail that was parked when the answer went out.

A scheduled digest writes exactly the same stash, so the buttons behave
identically whether you asked for the list or it arrived on a Monday morning.
Two differences, both deliberate:

- **A digest's stash lives 24 hours, a search's lives one.** You asked for the
  search a minute ago; the digest turned up at 09:00 and you are reading it at
  13:00, and a one-hour stash would answer your own digest with "той список уже
  застарів".
- **Only what was actually shown counts as sent.** The card is recorded when it
  goes out and each event as the cursor reaches it; the untouched tail is left
  unrecorded. Next week's digest may therefore re-offer something you never
  paged to, which is the point — fourteen events sitting in a stash have not
  been seen.

Both stashes live in `scrape_cache` with an `expires_at` that `pruneCache`
sweeps at the end of every fan-out, so there is one row per reader at a time
(about 15 KiB for a fifteen-event week — a few hundred users is single-digit
megabytes, held for a day).

`message_delay_ms` is the pause between the messages of one send. A digest is
now a header plus one card, so it barely applies there; what still needs it is
**📋 Показати списком**, which hands out `max_results` events in one go, and the
follow-alert and place-tip jobs, which are still one message per item. Telegram
throttles a sustained burst at roughly one message per second — lower this and
you will start seeing 429s (both `sendMessage` and `sendPhoto` retry once, then
give up on that message).

An event with a poster goes out as a photo, and Telegram fetches that file from
the source's CDN itself — so a photo card takes it several hundred milliseconds
longer to accept than a text one, which spaces a batch out further than this
setting alone would. 400ms has held for text; if a photo-heavy batch starts
logging 429s, `1000` is the value to move to, matching Telegram's own advice of
one message per second per chat.

Start with `public: false` and your own chat id on the allowlist while you try
it out; flip it to `true` when you are ready for strangers.

### Adding a city

Add a section under `cities:` and check the three slugs exist:

```bash
curl -sI https://concert.ua/en/catalog/<slug>/all-categories | head -1   # want 200
curl -sI https://<sub>.karabas.com/                          | head -1   # want 200
curl -sI https://<sub>.kontramarka.ua/uk/concert             | head -1   # want 200
```

Give the city a Ukrainian `label` — that is the name people see — and put every
spelling into `aliases` (including declensions and the English spelling:
"Харкові", "Kharkiv", "Kharkov"). Aliases are how free text and onboarding match
a city; only configured cities are offered to new users.

## 3. Secrets

Create `~/.hermes/.env` (shared with your other Hermes skills) or
`<skill>/.env`, starting from `.env.example`:

| Variable | What it is | Where to get it |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **the bot** — required | [@BotFather](https://t.me/BotFather) → `/newbot` |
| `TELEGRAM_CHAT_ID` | your own chat id: owner of `/stats` and `/broadcast`, where `/feedback` is forwarded, default for the CLI | message your bot, then `https://api.telegram.org/bot<TOKEN>/getUpdates` → `message.chat.id` |
| `TELEGRAM_API_ID` | user API, for reading channels (optional) | [my.telegram.org](https://my.telegram.org) → API development tools |
| `TELEGRAM_API_HASH` | same | same page |
| `TELEGRAM_SESSION` | your GramJS login (optional) | written by `scripts/tg-login.ts` (§6) |
| `DATABASE_URL` | Postgres instead of SQLite (optional) | your database |

The command menu — what Telegram autocompletes after `/` and shows behind the
☰ button — is published by the bot itself on every start (`setMyCommands`, from
`BOT_COMMANDS` in `src/bot-handlers.ts`), so there is nothing to type into
@BotFather. Add a command there and it appears in the menu on the next restart.

Two things are still worth setting in @BotFather by hand:

```
/setdescription  Знаходжу концерти, стендап, театр, виставки й нові місця в українських містах.
/setabouttext    Твоє місто, твій смак, одне повідомлення на тиждень.
```

The bot replies in Ukrainian and nothing else, so those two lines are Ukrainian
too. There is one language, so its copy sits next to the code that sends it —
`src/bot-handlers.ts` for the conversation, `src/render.ts` for events — rather
than in a catalogue with a lookup layer on top. Logs, CLI output, `/stats` and
`/broadcast` stay English: they are for whoever runs the bot. `/feedback` is the
exception on the operator side of that line — the person writing it is a user,
so it answers in Ukrainian and only the copy that reaches *you* is English.

## 4. Storage

Default: one SQLite file at `~/.hermes/data/events-finder/events.db`, created on
first run. Fine for one machine and a modest number of users.

Drizzle owns the schema (`drizzle/schema.sqlite.ts`, `drizzle/schema.pg.ts`) and
the same repository runs on Postgres — worth switching to once the bot has real
users, or if you deploy more than one process:

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/events_finder
npm run db:push        # create the tables (drizzle-kit)
npm run db:generate    # or generate SQL migrations into drizzle/migrations
npx tsx scripts/doctor.ts   # should report: postgres
```

Tables: `users`, `deliveries` (what each person was shown), `messages` (which
event each message was about, so a ❤️ on it resolves), `reminders`,
`scrape_cache`, `usage` (rate limits), `state`.

Every fan-out job ends with a prune, so none of these grow without end: expired
cache rows go immediately, `messages` after 120 days, `deliveries` after 180,
reminders 60 days past their event, and rate-limit buckets after 48 hours. The
retention is in `RETENTION` at the top of `src/db.ts`.

## 5. Run the bot

```bash
npx tsx scripts/bot.ts            # long-polls until stopped
npx tsx scripts/bot.ts --dry-run  # prints replies instead of sending
```

`--dry-run` stops the *sending* only. Preferences, onboarding stages, opt-ins
and reminders are still written, so point it at a throwaway database
(`EVENTS_FINDER_DB=/tmp/test.db`) if you do not want it touching real users.

Then message it `/start`.

**Only one copy may poll at a time** — Telegram gives each update to a single
`getUpdates` caller, so a second instance steals messages. When that happens
Telegram answers 409 and the bot stops with a message saying so, rather than
looping on the error.

### Taste

A new user starts from nothing and builds their profile in the `/start`
walkthrough: city, liked categories, dislikes, budget, who they follow. `/setup`
and `/settings → 🎛 Мої смаки` reopen the same screens.

From then on **an answer holds only what they like.** Anything matching nothing
in their profile is dropped, and the message says how many events that was. If
fewer than `bot.taste_floor` (default 5) of their things are on, the next best
are added back and the bot admits it, so a quiet week does not look like a bug.
Ask for something specific — «стендап на вихідних» — and the request wins over
the stored profile for that answer.

Every ❤️ feeds it: the category joins their favourites, its tally goes up (so a
category hearted ten times outranks one hearted once), and the performer joins
their follow list, where the heaviest weight lives — a followed act is searched
for by name and ignores both the dislike filter and the budget cap.

If your bot ran before the walkthrough existed, its users were handed a copy of
your `preferences.yaml`. Take it back off them:

```bash
npx tsx scripts/disinherit.ts        # dry run: what would change, per user
npx tsx scripts/disinherit.ts --yes  # write it
```

It removes only entries identical to the seed file; anything they added
themselves stays, as do their ❤️ tallies.

### As a service (systemd)

```ini
# /etc/systemd/system/events-finder-bot.service
[Unit]
Description=events-finder Telegram bot
After=network-online.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/.hermes/skills/events-finder
ExecStart=/usr/bin/npx tsx scripts/bot.ts
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now events-finder-bot
journalctl -u events-finder-bot -f
```

macOS equivalent: `pm2 start "npx tsx scripts/bot.ts" --name events-finder-bot`
or a launchd plist. If you cannot keep a process alive, run
`npx tsx scripts/bot.ts --once` from cron every minute instead — replies will
just be up to a minute late.

## 6. Telegram channels (optional)

Only needed for the channel source. It uses **one** login — the operator's — and
the events it finds are shared with every user, so you only do this once:

```bash
npx tsx scripts/tg-login.ts
```

Interactive, so run it in a terminal, never from cron. It asks for your phone
number, the code Telegram sends **in the app** (not SMS) and your 2FA password,
then writes `~/.hermes/data/events-finder/gramjs.session` (chmod 600).

That session is a logged-in session for your account — treat it like a password.

Then list channels per city in `config.yaml` and test:

```yaml
cities:
  kharkiv:
    telegram_channels: ["@kharkiv_afisha", "@standup_kharkiv"]
```

```bash
npx tsx scripts/telegram.ts --city kharkiv --days 14
npx tsx scripts/telegram.ts --channel @some_channel --dump   # see raw posts
```

## 7. Check it works

```bash
npx tsx scripts/doctor.ts            # config, secrets, db, users, source health
npx tsx scripts/doctor.ts --network  # also check every source site is reachable
npm test                             # 330 offline checks (~15s, no network)
npm run check                        # typecheck + tests, same as CI
```

## 8. Automate the digests

Copy the entries from `cron.example.yaml` into your Hermes cron file, or add
them with `hermes cron add` (both forms are there, plus a crontab fallback):

| When (Europe/Kyiv) | Job | Covers |
|---|---|---|
| **every hour** | `digest.ts --week` | whoever set that hour and today's weekday — header + one card |
| **every hour, Thursday** | `digest.ts --weekend --top 5` | whoever set that hour — header + one card |
| every 6 hours | `follows.ts` | each user's follow list — one message per alert |
| Sunday 11:00 | `places.ts` | each user's place taste — one message per place |
| every 15 minutes | `reminders.ts` | everyone's ❤️ reminders |

The two digest jobs tick **hourly** and the schedule lives on the user, not in
the cron: each person picks their hour and the days they want a digest from
`/settings → 🕘 Коли писати`. A tick that matches nobody logs one line and
exits without scraping anything, so 23 of every 24 runs are free.

Both digests arrive as **a header plus one card**, with the rest of the ranked
week in a stash you walk with the buttons under it (§Bot policy). The follow
alerts and place tips are left as they were — a single-event alert and three
place suggestions are not lists you page through.

Rehearse each one with `--dry-run`, and against yourself with
`--chat <your-chat-id>`, before letting it loose on real users:

```bash
npx tsx scripts/digest.ts --week --dry-run                    # whoever's hour it is now
npx tsx scripts/digest.ts --week --dry-run --hour 18 --day 5  # rehearse Friday 18:00
npx tsx scripts/digest.ts --week --dry-run --chat 123 --now   # ignore the schedule entirely
```

### Each person's own schedule

The whole schedule is **an hour and the days of the week**, set from
`/settings` → 🕘 Коли писати. Tick the days you want a digest on; Thursday's
digest covers Friday–Sunday, so ticking Thursday is how you ask for the
weekend picks. There is no separate "how often" — ticking two days *is* twice
a week.

| Setting | Default | What it does |
|---|---|---|
| `digest_hour` | `9` | the hour digests arrive, in `config.timezone` |
| `digest_days` | Mon + Thu | the weekdays a digest arrives, as one bit per day (bit 0 = Sunday). Written the first time someone taps the panel |
| `digest_day` / `digest_freq` | `1` / `twice` | **legacy only** — what a row that predates `digest_days` meant. Read when `digest_days` is still NULL, and ignored for good once that user taps a day |

One thing worth knowing:

- **`mine` means "only when there is something really mine"** — nothing is sent
  if `rank()` had to top the list up with off-taste items to reach
  `bot.taste_floor`. Someone on `mine` in a quiet week hears nothing at all,
  which is the request. It only has teeth once there is a taste model to judge
  against: with an empty profile `rank()` has nothing to filter by, never pads
  anything, and `mine` behaves like any other schedule. Nothing on the panel
  sets it any more; the column still decides for whoever has it.

Anyone registered before these columns existed reads as the defaults above, so
they keep getting exactly the Monday 09:00 + Thursday mailing they always did.

### Why only six hours to choose from

The hour picker offers **07, 09, 12, 15, 18, 21** and nothing else. That is a
politeness budget, not a UI shortcut. `cache.ttl_seconds` is 1800, so everyone
sharing one city *and one hour* shares a single scrape — but spreading users
over more hours means more scrapes of the same sites per day.

With 5 cities configured, as upper bounds (every slot occupied, every city):

| | distinct fan-outs / week | city-scrapes / week | per city, per day |
|---|---|---|---|
| one hard-wired cron (before) | 2 | 10 | 0.3 |
| 6 hour slots × 7 days (now) | 42 + 6 | 240 | ~6.9 (one every 3.5 h) |
| all 24 hours × 7 days | 168 + 24 | 960 | ~27 (more than one an hour) |

240 a week is 24× the old traffic and still gentler per site than one page per
three hours; 960 is not something to point at someone else's server. If even
that is too much, cut `DIGEST_HOURS` in `src/schedule.ts` — the hour buttons,
the validation and the tests all read from that one list. Real numbers land far
below the bound: it counts *occupied* slots, and a few dozen users cluster into
two or three of them.

## 9. Operating it

```bash
npx tsx scripts/prefs.ts --list                              # who is registered
npx tsx scripts/prefs.ts --chat 123456789                    # one person's taste
npx tsx scripts/prefs.ts --chat 123456789 "follow Latexfauna"
npx tsx scripts/prefs.ts --defaults "add jazz to favourites"  # your own profile
npx tsx scripts/reminders.ts --list                          # all pending reminders
npx tsx scripts/search.ts "stand-up in Lviv this weekend"    # answer by hand
```

- **Logs**: `~/.hermes/data/events-finder/logs/events-finder.log`
  (`EVENTS_FINDER_DEBUG=1` for more, `EVENTS_FINDER_QUIET=1` for clean stdout).
- **Users who block the bot** are detected on the next send and marked `blocked`,
  so they stop receiving everything. `/start` brings them back.
- **No repeats**: an event is re-sent to a person only when its date, price or
  availability changed, and the line says which (`🔁 нова дата`).
- **Card buttons**: every event message carries `ℹ️ Деталі`, `🔖 Зберегти`,
  `⏰ Нагадати` and `👎 Не моє` (`ev:<verb>:<item id>` callback data), plus
  `📅 В календар` — a plain link to Google's pre-filled form, and the one
  button an event without a start time does not get.
- **Reminders** are set by tapping ⏰ under an event message or ❤️ on it, and
  cancelled the same way — both go through the one reminder row, so a ❤️ then a
  ⏰ never leaves two. Typing `нагадай` still works for anyone who does neither.
  Either one also adds that event's category to the person's favourites.
- **👎 Не моє** is the mirror of the ❤️: the event's category loses a point in
  the `taste` tally, and at `-3` it moves from favourites to dislikes; the act
  on stage goes to `blocked_acts`, a stop list that outranks `follow`. The reply
  says what changed ("більше не показуватиму стендап"), and `/prefs` lists both
  what the bot likes and what it has stopped showing. `люблю <категорія>` or
  `слідкуй за <ім'я>` undoes either half.
- **`/stats`** in the chat (owner only) shows user counts, table sizes, and one
  line per source: how many items it last brought back and when.

### When a source dies quietly

A scraper that stops matching its site does not fail. `politeFetch` gets its
200, cheerio matches nothing, the collector returns `{ ok: true, items: [] }`,
and `failedSources` never hears about it — the digests just get thinner.

So the fan-out counts instead. Every tick, each source's per-city answer goes to
`src/health.ts`, which keeps one counter per source in the `state` table. A
source is reported **dead** once it has returned nothing on **3 consecutive
ticks while other sources did find events in the same cities**. That last clause
is the whole thing: without it, a quiet Tuesday in Dnipro looks exactly like a
broken parser.

- The owner gets **one** message per outage, in English, with the command that
  reproduces it — and one more when the source starts working again.
- Counters live in the database, so a restart does not lose them. A source
  that returns anything at all resets to zero.
- **Nothing extra is fetched.** The detector only reads scrapes that were
  already going to happen; a cache hit asked nobody anything and is counted as
  no evidence either way.
- A source with no section for a city in `config.yaml` is "never asked", not
  empty. A source that *threw* is left alone too — that one is already loud, in
  `failedSources` and the log.
- **websearch** and **telegram** get their own wording: an empty websearch means
  nobody has run the `places.ts --queries` → `websearch.ts --ingest` hand-off
  lately, and an empty telegram usually means the GramJS session expired. Both
  are different problems with different fixes from "the markup moved".

`npx tsx scripts/doctor.ts` prints the same counters, so the doctor and the bot
never disagree about which source is healthy. `--network` only answers whether
the sites are *reachable*, which a site that changed its markup also is.

**What it does not catch**: a tick where *every* source came back empty counts
as no evidence, so a break on our side — a normalizer or a date filter that
rejects everything — is invisible to the counters. That half is the fixture
contract tests' job: `tests/fixtures/` holds pages captured from the real sites,
and `npm test` asserts each parser still gets a title, a date and a price out of
them. Those fail when we break a parser; they stay green when a live site moves,
because the committed fixture does not move with it. The two halves together,
not either alone.

- **`/feedback <text>`** is the channel pointing the other way: open to
  anyone, Ukrainian, stored in the `feedback` table **and** forwarded to the
  owner's chat. Stored as well as forwarded on purpose — a message that only
  ever existed in one chat is lost the moment you scroll past it. Capped at
  `bot.feedback_per_hour` per person, in its own hourly bucket, so writing in
  never costs somebody a search. `/feedback` with no text reads the stored copy
  back — the newest ten — when the owner sends it.

### Running it: `/stats` and `/broadcast`

Both are owner-only (`TELEGRAM_CHAT_ID`), both are invisible otherwise — they
are not in the published command menu and they answer a stranger with the same
one line, so neither can be found by guessing.

- **`/broadcast <message>`** announces something to every active user. It never
  sends on the command: it replies with the announcement itself, exactly as the
  audience will see it, and a confirm button under it. HTML is allowed, and a
  malformed tag fails on that preview — once, to you — instead of failing
  identically for everyone on the list. Confirming paces the sends with
  `bot.send_delay_ms` and marks any chat Telegram says is gone as blocked, the
  same way a digest fan-out does, then reports how many landed and how many
  fell off. `--dry-run` prints instead of sending.

- **`/stats`** reports the table sizes, and then the four things that say
  whether any of this works:

  | block | the question |
  |---|---|
  | Do people page? | how many answers got at least one `Далі →`, and how deep the people who do walk, go. If nobody pages, the 37 events in a stash do not exist. |
  | Reactions per job | ❤️ / 👎 / 🔖 / ⏰ counted separately for weekly digests, weekend picks, follow alerts, place tips and on-demand searches |
  | Gesture coverage | the share of sent events that were ever touched at all |
  | Padding frequency | how often `rank()` had to let off-taste events back in — overall and per city, which is the direct measure of whether a city has anything worth ranking |

  All of it is **counters**, not a log: keys in a `counters` table, incremented
  in place. A tap costs an increment, never a row, so nothing here grows with
  use the way `messages` and `deliveries` do (and those are swept by
  `Store.prune()`). What makes it work is two additive columns — `messages.job`,
  so a ❤️ three days later is credited to the digest that earned it, and
  `deliveries.gestures`, which is only ever read as "was this zero" and is what
  lets coverage count events instead of taps. Ticket links are **not** tracked.

### Being a good citizen

The source sites are small businesses, not APIs. What keeps this acceptable:
1.5 s between requests to the same host, one scrape per city per 30 minutes
shared by all users, 20 searches per user per hour, 5 `/feedback` messages per
user per hour, and 2 pages per source for interactive replies. Raising any of those multiplies load on them, not on you.

## 10. Layout

```
SKILL.md                  instructions for the agent
README.md                 this file
TESTING.md                manual test checklist
cron.example.yaml         the scheduled fan-out jobs
config.example.yaml       sites, cities, bot policy, cache
preferences.example.yaml  the operator's own taste model (CLI defaults)
.env.example              secrets template
scripts/
  bot.ts                  the bot service (long-poll, or --once for cron)
  concertua.ts karabas.ts kontramarka.ts telegram.ts websearch.ts
  search.ts digest.ts follows.ts places.ts reminders.ts
  prefs.ts disinherit.ts tg-login.ts doctor.ts
src/
  bot-handlers.ts         the conversation, the buttons and the ❤️ reaction
  users.ts                chat id ↔ taste model
  cache.ts                one scrape per city
  fanout.ts               scheduled jobs across all users
  health.ts               counts the ok-but-empty runs, and says so once
  schedule.ts             each person's hour and days
  pipeline.ts request.ts rank.ts dedupe.ts normalize.ts render.ts
  db.ts config.ts schemas.ts types.ts http.ts jsonld.ts log.ts …
drizzle/                  database schema (sqlite + postgres)
tests/                    offline suite and fixtures
.github/workflows/ci.yml  typecheck + the offline suite, on push and PR
```

Data is validated with zod at every boundary: YAML config, scraped schema.org
markup, Telegram API payloads, the web-search hand-off, stored preferences and
anything read back out of the database.
