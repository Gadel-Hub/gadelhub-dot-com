# GADEL Hub website

Static bilingual homepage for the GTÜ Game Development & Electronics Community. The public pages are `tr/index.html` and `en/index.html`; they work without JavaScript or a server-side runtime.

## Edit content

Update `content/home.json` for the featured placeholder, project areas, weekly resources, events, and collaboration text. Each record has one stable `id`; visible text is stored under `tr` and `en`. Keep verified facts and links in both languages. Empty `events.items` displays the existing no-schedule notice. If an event is added, give it an ISO 8601 date with a timezone, a location, and bilingual title and description. Edit `src/tr/index.html` and `src/en/index.html` only for layout or other static page copy. Do not edit generated locale pages by hand.

For guided entry, run `python3 scripts/new.py <type>`, where `<type>` is `project`, `event`, or `resource` to add a record, or `featured` or `team` to edit the existing singleton. To edit an existing list record, run `python3 scripts/new.py <type> --edit <id>`. The helper asks for Turkish and English text, validates the result, and requests confirmation before saving. It does not generate the public pages.

## Validate and build

From the repository root, using Python 3:

```sh
python3 scripts/build.py --validate
python3 scripts/build.py
python3 scripts/build.py --check
```

Validation checks required fields, bilingual text, stable unique IDs, HTTPS URLs, and event dates. `--check` also reports stale generated pages. Commit the JSON, templates if changed, and both generated pages together.

## Review external candidates

`scripts/update_external.py` fetches active full-game offers from the [GamerPower API](https://www.gamerpower.com/api-read) and jams starting within seven days or still active after starting within three days from the [gamejam.gg calendar feed](https://gamejam.gg/calendar.ics). It writes **candidates for human review**, not approved website content, to `content/proposals/weekly.json`. It never edits `content/home.json` or generates the public pages.

```sh
python3 scripts/update_external.py
python3 scripts/update_external.py --source games
python3 scripts/update_external.py --source jams
python3 scripts/update_external.py --dry-run
```

Review source links, dates, eligibility, and relevance before manually promoting anything into the bilingual site content. If GamerPower data is published, its terms require attribution with an active hyperlink to GamerPower.com; the proposal preserves that requirement. Running the same sources without meaningful changes leaves the proposal file untouched.

## Preview locally

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/tr/` or `http://localhost:8000/en/`. The root `index.html` points to Turkish and offers an English link.

Shared styles live in `styles.css`. The hero SVG is an illustration; featured content and event notices are explicitly placeholders until verified community material is supplied. The website uses a cropped derivative of the original logo in `assets/logo/`; the original JPEG remains unchanged.
