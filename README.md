# events-finder

A Telegram bot — and the Hermes Agent skill behind it — that finds events and
places in Ukrainian cities, ranks them against each user's taste, and sends
personalised digests, alerts and reminders.

- **Events**: concerts, stand-up, theatre, exhibitions, lectures, parties, festivals, workshops
- **Places**: new cafés, bars with live music, galleries, unusual spots
- **Sources**: Concert.ua, Karabas, Kontramarka, Telegram channels (GramJS), web search
- **Cities**: Kharkiv (default), Kyiv, Lviv, Dnipro, Odesa, Ivano-Frankivsk — add any
- **Multi-user**: every person gets their own city, taste, digest settings and reminders
- **Ukrainian**: the bot speaks Ukrainian only; it still understands requests typed in Russian or English
- **One message per event**, so a ❤️ on it means exactly that event

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
                                        header + one message per event, each one ❤️-able
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
  max_results: 10
  interactive_pages: 2     # pages per source while someone waits for a reply
  send_delay_ms: 60        # pause between users when fanning out a digest
  message_delay_ms: 400    # pause between the messages of one digest

cache:
  ttl_seconds: 1800        # one scrape per city serves everyone for this long
```

`message_delay_ms` exists because every event is its own message: a ten-event
week is eleven sends to the same chat, and Telegram throttles a sustained burst
at roughly one message per second. Lower it and you will start seeing 429s
(`sendMessage` retries once, then gives up on that message).

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
| `TELEGRAM_CHAT_ID` | your own chat id: owner of `/stats`, default for the CLI | message your bot, then `https://api.telegram.org/bot<TOKEN>/getUpdates` → `message.chat.id` |
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
than in a catalogue with a lookup layer on top. Logs, CLI output and `/stats`
stay English: they are for whoever runs the bot.

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
npx tsx scripts/doctor.ts            # config, secrets, db, users, bot policy
npx tsx scripts/doctor.ts --network  # also probe every source site
npm test                             # 159 offline checks (~3s, no network)
```

## 8. Automate the digests

Copy the entries from `cron.example.yaml` into your Hermes cron file, or add
them with `hermes cron add` (both forms are there, plus a crontab fallback):

| When (Europe/Kyiv) | Job | Covers |
|---|---|---|
| Monday 09:00 | `digest.ts --week` | every subscriber, in their own city |
| Thursday 18:00 | `digest.ts --weekend --top 5` | same |
| every 6 hours | `follows.ts` | each user's follow list |
| Sunday 11:00 | `places.ts` | each user's interests |
| every 15 minutes | `reminders.ts` | everyone's ❤️ reminders |

Rehearse each one with `--dry-run`, and against yourself with
`--chat <your-chat-id>`, before letting it loose on real users.

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
- **Reminders** are set by tapping ❤️ on an event message, and cancelled by
  taking the ❤️ off. Typing `нагадай` still works for anyone who does not react.
  A heart also adds that event's category to the person's favourites.
- **`/stats`** in the chat (owner only) shows user counts and table sizes.

### Being a good citizen

The source sites are small businesses, not APIs. What keeps this acceptable:
1.5 s between requests to the same host, one scrape per city per 30 minutes
shared by all users, 20 searches per user per hour, and 2 pages per source for
interactive replies. Raising any of those multiplies load on them, not on you.

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
  pipeline.ts request.ts rank.ts dedupe.ts normalize.ts render.ts
  db.ts config.ts schemas.ts types.ts http.ts jsonld.ts log.ts …
drizzle/                  database schema (sqlite + postgres)
tests/                    offline suite and fixtures
```

Data is validated with zod at every boundary: YAML config, scraped schema.org
markup, Telegram API payloads, the web-search hand-off, stored preferences and
anything read back out of the database.
