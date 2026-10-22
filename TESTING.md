# Test checklist

Run from the skill directory. `npm test` is offline; everything else touches the
network, and only the steps marked **sends** deliver Telegram messages.

```bash
cd ~/.hermes/skills/events-finder
```

> **Test against yourself.** Every scheduled job takes `--chat <your-chat-id>`.
> Use it until you are confident, or you will message real users while poking at
> things.

## 0. Automated suite (start here)

```bash
npm test          # 107 offline checks: parsing, classification, dedupe, ranking,
                  # rendering, per-user store, users, fan-out, bot handlers
npm run typecheck # tsc --noEmit
```

Uses a temporary database and the committed example config, so it is safe at any
time and needs no secrets. Expect `107/107 passed` and exit code 0.

Notable cases it covers, so you do not have to by hand: a city is scraped once
and ranked per user; a muted user is skipped; an already-delivered item is not
repeated; a new user inherits no taste at all; the walkthrough turns taps into
a stored profile and clears the stage at the end; abandoning it after the city
still leaves someone in the digest list; `🔔 2` resolves to the second line of
a digest; one user's "already sent" does not affect another's.

## 1. Health check

```bash
npx tsx scripts/doctor.ts
npx tsx scripts/doctor.ts --network
```

Expect: node ≥ 20; `config.yaml` and `preferences.yaml` found (not the
`.example.` fallbacks); the database reachable with a users-per-city line; the
bot token accepted; the cache enabled. A missing `TELEGRAM_BOT_TOKEN` is ❌ — fix
it before anything that sends.

## 2. One source at a time

Run each and eyeball ~5 items: title right, venue present, time plausible, price
sane, link live?

```bash
npx tsx scripts/concertua.ts   --city kharkiv --from <today> --to <today+7>
npx tsx scripts/karabas.ts     --city kharkiv --from <today> --to <today+7>
npx tsx scripts/kontramarka.ts --city kharkiv --from <today> --to <today+14>
npx tsx scripts/telegram.ts    --city kharkiv --days 14
npx tsx scripts/websearch.ts   --city kharkiv
```

| What to look for | Good sign |
|---|---|
| items returned | more than zero for a 7-day window in a big city |
| dates | all inside the window you asked for |
| prices | `350–900 ₴` / `from 450 ₴` / `up to 390 ₴`, not `price n/a` everywhere |
| statuses | some `scheduled`; `КВИТКІВ НЕМАЄ`/`СКАСОВАНО` badges where the site says so |
| politeness | ~1.5 s between requests in the log, not a burst |

Add `--json | head -40` for raw fields, `--pages 1` to go faster.

**Expected empties:** `telegram` returns nothing until
`cities.<city>.telegram_channels` is filled in and `tg-login.ts` has run;
`websearch` returns nothing until something is ingested (§5).

**Failure handling:** break a source on purpose (set a bogus `concertua.slug`)
and run `search.ts`. It must still print a digest from the other sources and
warn `⚠️ sources that failed: concert.ua`.

## 3. The bot, end to end (**sends**)

```bash
npx tsx scripts/bot.ts
```

In Telegram, as yourself:

1. `/start` → a greeting and a city keyboard. Pick a city → it confirms, then
   the walkthrough carries on by itself: tap two categories → **Далі →** →
   dislikes → **Далі →** → a budget → the follow step → type
   `Антон Тимошенко, Latexfauna` → **Готово ✅** → a summary of exactly what you
   tapped, and nothing you did not. `npx tsx scripts/prefs.ts --chat <your id>`
   should agree with it, and show no favourites you never chose.
   Then `/setup` → the same screens again, pre-ticked.
2. `/weekend` → "⏳ Шукаю…" then a numbered digest grouped by day, in Ukrainian.
3. Reply `🔔 2` to it → "⏰ Нагадування поставив — …".
4. `npx tsx scripts/reminders.ts --list` → the reminder is there with your chat id.
5. `додай джаз до улюблених` → "✅ Записав: улюблене + джаз". The English
   phrasings still work too.
6. `/prefs` → jazz is listed.
7. `stand-up this weekend` → a search, not a preference change.
8. Type `/` → Telegram autocompletes the command list, and the ☰ button next
   to the text field shows the same menu.
9. `/settings` → a panel with a button per digest. Tap **Вихідні** → the
   same message redraws with ❌ and no new message appears; tap it again → ✅.
10. In the panel: **Change city** → city buttons → pick one → back to the panel
    with the new city. **🎛 Мої смаки** → the summary plus a button per screen;
    open **💸 Бюджет**, change it, and ⬅️ Назад returns to the summary rather
    than marching you through a walkthrough.
11. `/mute weekend`, then `/settings` → the panel shows the weekend flag ❌ too.
12. `/city` → keyboard; pick another city; `/today` → events from the new city.
13. `/nonsense` → the help text.
14. `/stop`, or **Unsubscribe** in the panel (which asks first) → unsubscribed.
    `npx tsx scripts/prefs.ts --list` shows them gone from the active list.
    `/start` brings them back, with quick-action buttons under the greeting.

Then **as a second person** (another Telegram account, or a friend): `/start`,
pick a different city, set a different taste. Both of you should now be in
`npx tsx scripts/prefs.ts --list` — with different profiles, neither of them
yours.

### Followed acts are searched for by name

```bash
npx tsx scripts/follows.ts --queries --chat <your id>
```

Expect one entry per city you care about, listing a query per name on your
follow list (`Антон Тимошенко Харків концерт тур квитки`). Run them with
web_search, ingest with `npx tsx scripts/websearch.ts --ingest -`, then
`npx tsx scripts/follows.ts --dry-run --chat <your id>` — anything found should
come through even if its ticket costs more than your limit.

### Multi-user behaviour — the thing that matters

```bash
npx tsx scripts/digest.ts --week --dry-run --chat <id1>,<id2> --pages 1
```

The summary line must read like:

```
weekly digest: N item(s) to 2/2 user(s) across 1 city/cities (1 scrape(s), 0 cached)
```

- **two users in the same city → 1 scrape**, not 2
- run it again immediately → `0 scrape(s), 1 cached`
- the two digests differ: each reflects that user's favourites and dislikes
- two users in *different* cities → 2 scrapes, 2 cities

Also check isolation:

```bash
npx tsx scripts/digest.ts --week --chat <id1> --pages 1    # sends to id1 only
npx tsx scripts/digest.ts --week --chat <id1> --pages 1    # second run: quiet, already sent
npx tsx scripts/digest.ts --week --chat <id2> --pages 1    # id2 still gets the full list
```

### Rate limiting

Send the bot more than `bot.searches_per_hour` searches (default 20) in an hour.
It should refuse politely and say scheduled digests still arrive — and your
scheduled jobs must keep working for that user.

### Allowlist

Set `bot.public: false` with an empty `allowlist`, restart the bot, message it
from a second account: it should reply that the bot is private. Your own chat
(`TELEGRAM_CHAT_ID`) still works.

## 4. Dry-run every scheduled job

None of these send with `--dry-run`:

```bash
npx tsx scripts/digest.ts  --week --dry-run                 # Monday 09:00 job
npx tsx scripts/digest.ts  --weekend --top 5 --dry-run      # Thursday 18:00 job
npx tsx scripts/follows.ts --dry-run                        # every-6-hours job
npx tsx scripts/places.ts  --dry-run                        # weekly job
npx tsx scripts/reminders.ts --dry-run                      # every-15-minutes job
npx tsx scripts/bot.ts     --once --dry-run                 # message drain
```

Checks:
- `--week` covers today → Sunday; `--weekend` covers Friday → Sunday
- `--weekend --top 5` prints at most five items per user
- `follows.ts` says `nothing new from anyone on the follow lists` until someone
  follows a performer who is actually playing — add one with
  `npx tsx scripts/prefs.ts --chat <id> "follow <someone on a poster>"` and
  re-run to see an alert
- running a digest twice shows fewer items the second time; `--all` shows the
  full list again
- without `TELEGRAM_BOT_TOKEN` and without `--dry-run`, each job exits 1 with one
  clear line (no stack trace)

Then the real thing, against yourself only (**sends**):

```bash
npx tsx scripts/digest.ts --weekend --top 5 --chat <your-chat-id>
```

## 5. Web-search hand-off

```bash
npx tsx scripts/places.ts --queries          # one entry per city that has users
# run those queries with web_search, save as results.json
npx tsx scripts/websearch.ts --ingest results.json --kind place --city kharkiv
npx tsx scripts/places.ts --dry-run
npx tsx scripts/websearch.ts --clear          # start over
```

Expect Ukrainian queries with the Ukrainian city name, `ingested N/M`, and
places rendered as a flat list with addresses and no times.

## 6. Reminders

To test firing without waiting: set a reminder on an event starting within ~3
hours, then

```bash
npx tsx scripts/reminders.ts --dry-run    # shows it as due
npx tsx scripts/reminders.ts              # fires once (sends)
npx tsx scripts/reminders.ts              # nothing due
npx tsx scripts/reminders.ts --list --chat <id>
npx tsx scripts/reminders.ts --cancel <item-id> --chat <id>
```

A reminder for an event that already started (more than an hour ago) must never
fire.

## 7. Logs

```bash
tail -n 40 ~/.hermes/data/events-finder/logs/events-finder.log
tail -f    ~/.hermes/data/events-finder/logs/events-finder.log   # while a job runs
EVENTS_FINDER_DEBUG=1 npx tsx scripts/search.ts --city kharkiv --pages 1
EVENTS_FINDER_QUIET=1 npx tsx scripts/search.ts --city kharkiv --json   # clean stdout
```

Every job logs: one line per source page, a `pipeline:` summary
(`N raw → N unique → N kept`), a `cache hit` line when a city was reused, one
`sent to <chat>` per delivery, and a closing summary with scrape/cache counts.
`ERROR` lines are always printed even under `EVENTS_FINDER_QUIET=1`.

For the bot service: `journalctl -u events-finder-bot -f` (systemd) or
`pm2 logs events-finder-bot`. Each handled message logs its chat id and how long
it took.

## 8. Database

```bash
sqlite3 ~/.hermes/data/events-finder/events.db '.tables'
sqlite3 ~/.hermes/data/events-finder/events.db 'select chat_id, city, weekly_digest, blocked from users;'
sqlite3 ~/.hermes/data/events-finder/events.db 'select chat_id, title, last_sent_at, send_count from deliveries order by last_sent_at desc limit 5;'
sqlite3 ~/.hermes/data/events-finder/events.db 'select chat_id, title, starts_at, fired_1d, fired_3h from reminders;'
sqlite3 ~/.hermes/data/events-finder/events.db 'select key, expires_at from scrape_cache;'
```

Tables: `users`, `deliveries`, `messages`, `reminders`, `scrape_cache`, `usage`,
`state`. Deleting `events.db` resets everything, **including who your users
are** — they would each have to `/start` again.

With Postgres: `DATABASE_URL=... npm run db:push`, then
`DATABASE_URL=... npx tsx scripts/doctor.ts` — the storage line should say
`postgres`.
