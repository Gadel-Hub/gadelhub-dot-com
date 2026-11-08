#!/usr/bin/env python3
"""Validate source content and build the complete static site in dist/."""
import argparse
from datetime import datetime
from html import escape
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
import sys
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
LANGS = ('tr', 'en')
TOKENS = ('FEATURED', 'PROJECTS', 'TEAMS', 'WEEK', 'EVENTS')
PROJECT_DOMAINS = ('game-development', 'electronics-embedded')


def localized(value, name):
    if not isinstance(value, dict) or set(value) != set(LANGS):
        raise ValueError(f'{name}: expected tr and en text')
    for lang in LANGS:
        if not isinstance(value[lang], str) or not value[lang].strip():
            raise ValueError(f'{name}.{lang}: required nonempty text')


def url(value, name):
    if not isinstance(value, str):
        raise ValueError(f'{name}: required URL')
    parsed = urlparse(value)
    if parsed.scheme != 'https' or not parsed.netloc or any(c.isspace() for c in value):
        raise ValueError(f'{name}: expected an absolute HTTPS URL')


def validate(data):
    if not isinstance(data, dict) or set(data) != {'featured', 'projects', 'week', 'events', 'teams'}:
        raise ValueError('Expected featured, projects, week, events, and teams')
    seen = set()

    def record(item, name):
        if not isinstance(item, dict):
            raise ValueError(f'{name}: expected an object')
        value = item.get('id')
        if not isinstance(value, str) or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', value):
            raise ValueError(f'{name}.id: required stable kebab-case ID')
        if value in seen:
            raise ValueError(f'{name}.id: duplicate ID {value}')
        seen.add(value)

    featured = data['featured']
    record(featured, 'featured')
    if not isinstance(featured.get('placeholder'), bool):
        raise ValueError('featured.placeholder: required boolean')
    for key in ('badge', 'title', 'description'):
        localized(featured.get(key), f'featured.{key}')

    for group, fields in (
        ('projects', ('title', 'description')),
        ('resources', ('title', 'description')),
        ('items', ('title', 'description')),
    ):
        items = (
            data['projects'] if group == 'projects'
            else data['week']['resources'] if group == 'resources'
            else data['events']['items']
        )
        if not isinstance(items, list):
            raise ValueError(f'{group}: expected a list')
        for index, item in enumerate(items):
            name = f'{group}[{index}]'
            record(item, name)
            for field in fields:
                localized(item.get(field), f'{name}.{field}')
            if group == 'projects':
                if not isinstance(item.get('symbol'), str) or not item['symbol'].strip():
                    raise ValueError(f'{name}.symbol: required')
                if not isinstance(item.get('verified'), bool):
                    raise ValueError(f'{name}.verified: required boolean')
                if item.get('domain') not in PROJECT_DOMAINS:
                    raise ValueError(f'{name}.domain: unrecognized project domain')
            if group == 'resources':
                url(item.get('url'), f'{name}.url')
                validate_external(item.get('external'), f'{name}.external')
            if group == 'items':
                date = item.get('date')
                try:
                    parsed = datetime.fromisoformat(date)
                    if parsed.tzinfo is None or parsed.utcoffset() is None:
                        raise ValueError
                except (TypeError, ValueError):
                    raise ValueError(f'{name}.date: expected ISO 8601 date with timezone') from None
                if not isinstance(item.get('location'), str) or not item['location'].strip():
                    raise ValueError(f'{name}.location: required')
                validate_external(item.get('external'), f'{name}.external')

    for section in ('week', 'events', 'teams'):
        record(data[section], section)
    for field in ('notice',):
        localized(data['week'].get(field), f'week.{field}')
        localized(data['events'].get(field), f'events.{field}')
    localized(data['events'].get('description'), 'events.description')
    localized(data['teams'].get('description'), 'teams.description')
    localized(data['teams'].get('link_label'), 'teams.link_label')
    url(data['teams'].get('url'), 'teams.url')


def validate_external(value, name):
    if value is None:
        return
    if not isinstance(value, dict):
        raise ValueError(f'{name}: expected object')
    for field in ('candidate_id', 'source_name', 'source_id'):
        if not isinstance(value.get(field), str) or not value[field].strip():
            raise ValueError(f'{name}.{field}: required')
    url(value.get('source_url'), f'{name}.source_url')
    attribution = value.get('attribution')
    if not isinstance(attribution, dict):
        raise ValueError(f'{name}.attribution: required')
    if not isinstance(attribution.get('label'), str) or not attribution['label'].strip():
        raise ValueError(f'{name}.attribution.label: required')
    url(attribution.get('url'), f'{name}.attribution.url')
    if not isinstance(attribution.get('active_link_required'), bool):
        raise ValueError(f'{name}.attribution.active_link_required: required boolean')
    if 'platforms' in value and (
        not isinstance(value['platforms'], list)
        or not all(isinstance(x, str) for x in value['platforms'])
    ):
        raise ValueError(f'{name}.platforms: expected text list')
    if value.get('end_at') is not None:
        try:
            datetime.fromisoformat(value['end_at'])
        except (TypeError, ValueError):
            raise ValueError(f'{name}.end_at: expected ISO 8601 date') from None


def h(value):
    return escape(value, quote=True)


def home_featured(featured, lang):
    media_label = {
        'tr': 'Topluluk proje görselleri için ayrılan alan',
        'en': 'Space for community project images',
    }[lang]
    projects_label = {'tr': 'Projeler', 'en': 'Projects'}[lang]
    return (
        f'<div class="feature-content" data-content-id="{h(featured["id"])}">'
        f'<div class="feature-media" aria-label="{media_label}">'
        '<div class="media-icons"><img src="../assets/illustrations/gamepad.svg" alt="">'
        '<span>+</span><img src="../assets/illustrations/chip.svg" alt=""></div>'
        f'<small>{h(featured["badge"][lang])}</small></div>'
        f'<div class="feature-details"><h3>{h(featured["title"][lang])}</h3>'
        f'<span class="feature-tag">{h(featured["badge"][lang])}</span>'
        f'<p>{h(featured["description"][lang])}</p>'
        f'<a class="feature-link" href="/{lang}/projects/" '
        f'aria-label="{projects_label}">→</a></div></div>'
    )


def home_projects(projects, lang):
    cells = []
    for project in projects:
        domain = project['domain']
        icon = 'gamepad' if domain == 'game-development' else 'chip'
        title, description = h(project['title'][lang]), h(project['description'][lang])
        cells.append(
            f'<article class="glance-cell" data-content-id="{h(project["id"])}">'
            f'<img src="../assets/illustrations/{icon}.svg" alt="">'
            f'<div><h3>{title}</h3><p title="{description}">{description}</p></div>'
            f'<a href="/{lang}/projects/#{domain}" aria-label="{title}">›</a></article>'
        )
    return '<div class="glance-grid">' + ''.join(cells) + '</div>'


def home_teams(teams, lang):
    return (
        f'<div class="team-body" id="join" data-content-id="{h(teams["id"])}">'
        f'<p>{h(teams["description"][lang])}</p>'
        f'<a class="small-button" href="{h(teams["url"])}">'
        f'{h(teams["link_label"][lang])} →</a></div>'
    )


def external_credit(item):
    attribution = item.get('external', {}).get('attribution', {})
    if attribution.get('active_link_required'):
        return f' <a href="{h(attribution["url"])}">{h(attribution["label"])}</a>'
    return ''


def home_week(week, lang):
    label = {'tr': 'Faydalı kaynaklar', 'en': 'Useful resources'}[lang]
    resources = []
    for index, item in enumerate(week['resources']):
        icon = 'gamepad' if index % 2 == 0 else 'chip'
        resources.append(
            f'<li data-content-id="{h(item["id"])}">'
            f'<img src="../assets/illustrations/{icon}.svg" alt="">'
            f'<div><h3><a href="{h(item["url"])}">{h(item["title"][lang])}</a></h3>'
            f'<p>{h(item["description"][lang])}{external_credit(item)}</p></div>'
            '<span aria-hidden="true">›</span></li>'
        )
    return (
        f'<div class="week-intro" data-content-id="{h(week["id"])}">'
        f'<h3>{label}</h3><p>{h(week["notice"][lang])}</p></div>'
        '<ul>' + ''.join(resources) + '</ul>'
    )


def home_events(events, lang):
    if not events['items']:
        return (
            f'<div class="events-empty" data-content-id="{h(events["id"])}">'
            '<svg class="calendar-empty" aria-hidden="true">'
            '<use href="../assets/illustrations/homepage-icons.svg#calendar"></use></svg>'
            f'<h3>{h(events["notice"][lang])}</h3>'
            f'<p>{h(events["description"][lang])}</p></div>'
        )
    items = []
    for item in events['items']:
        date = datetime.fromisoformat(item['date'])
        date_label = date.strftime('%d.%m.%Y · %H:%M' if lang == 'tr' else '%Y-%m-%d · %H:%M')
        items.append(
            f'<li data-content-id="{h(item["id"])}">'
            f'<time datetime="{h(item["date"])}">{date_label}</time>'
            f'<h3>{h(item["title"][lang])}</h3>'
            f'<p>{h(item["location"])} · {h(item["description"][lang])}'
            f'{external_credit(item)}</p></li>'
        )
    return '<ul class="event-list">' + ''.join(items) + '</ul>'


def render(data, lang):
    snippets = {
        'FEATURED': home_featured(data['featured'], lang),
        'PROJECTS': home_projects(data['projects'], lang),
        'TEAMS': home_teams(data['teams'], lang),
        'WEEK': home_week(data['week'], lang),
        'EVENTS': home_events(data['events'], lang),
    }
    template = (ROOT / 'src' / lang / 'index.html').read_text(encoding='utf-8')
    for token in TOKENS:
        marker = '{{' + token + '}}'
        if template.count(marker) != 1:
            raise ValueError(f'{lang} template: expected one {marker}')
        template = template.replace(marker, snippets[token])
    return template


def project_domain_label(domain, lang):
    labels = {
        'game-development': {'tr': 'Oyun geliştirme', 'en': 'Game development'},
        'electronics-embedded': {'tr': 'Elektronik & gömülü', 'en': 'Electronics & embedded'},
    }
    return labels[domain][lang]


def project_upper(text, lang):
    return (text.replace('i', 'İ') if lang == 'tr' else text).upper()


def project_directory_label(domain, lang):
    if domain == 'electronics-embedded':
        return {'tr': 'ELEKTRONİK / GÖMÜLÜ', 'en': 'ELECTRONICS / EMBEDDED'}[lang]
    return project_upper(project_domain_label(domain, lang), lang)


def project_domain_index(data, lang):
    links = []
    for domain in PROJECT_DOMAINS:
        records = [p for p in data['projects'] if p['domain'] == domain]
        published = [p for p in records if p['verified']]
        subtitle = (published[0]['title'][lang] if published else
                    records[0]['description'][lang] if records else '')
        icon = 'gamepad' if domain == 'game-development' else 'chip'
        links.append(
            f'<a href="#{domain}"><img src="../../assets/illustrations/{icon}.svg" alt="">'
            f'<span>{project_directory_label(domain, lang)}<small>{h(subtitle)}</small></span>'
            '<b aria-hidden="true">↓</b></a>'
        )
    label = {'tr': 'Proje alanları', 'en': 'Project domains'}[lang]
    return f'<nav class="domain-index" aria-label="{label}">' + ''.join(links) + '</nav>'


def project_feature(project, lang):
    domain = project['domain']
    label = project_directory_label(domain, lang)
    icon = 'gamepad' if domain == 'game-development' else 'chip'
    # These are the approved presentation annotations for this known project,
    # not additional content records or project imagery. Other projects get no
    # inferred platform or content metadata.
    stm32 = project['id'] == 'stm32-beginner-resources'
    plate_label = 'STM32' if stm32 else h(project['symbol'])
    metadata = ''
    if stm32:
        content = {'tr': 'İÇERİK', 'en': 'CONTENT'}[lang]
        documentation = {'tr': 'Dokümantasyon', 'en': 'Documentation'}[lang]
        examples = {'tr': 'Pratik örnekler', 'en': 'Practical examples'}[lang]
        metadata = ('<div><dt>PLATFORM</dt><dd>STM32</dd></div>'
                    f'<div><dt>{content}</dt><dd>{documentation}<br>{examples}</dd></div>')
    field = {'tr': 'ALAN', 'en': 'FIELD'}[lang]
    field_label = (
        {'tr': 'Elektronik / gömülü', 'en': 'Electronics / embedded'}[lang]
        if domain == 'electronics-embedded' else project_domain_label(domain, lang)
    )
    verified_label = {'tr': 'DOĞRULANMIŞ PROJE', 'en': 'VERIFIED PROJECT'}[lang]
    rail_label = {'tr': 'Proje bilgileri', 'en': 'Project information'}[lang]
    title_id = f'project-{project["id"]}-title'
    return (
        f'<article class="stm32-feature" aria-labelledby="{title_id}" '
        f'data-content-id="{h(project["id"])}" data-domain="{domain}" data-verified="true">'
        f'<div class="chip-plate" aria-hidden="true"><span class="plate-label">{plate_label}</span>'
        f'<img src="../../assets/illustrations/{icon}.svg" alt="">'
        f'<span class="plate-caption">{label}</span></div>'
        '<div class="project-story">'
        f'<span class="project-category">{h(project_upper(project_domain_label(domain, lang), lang))}</span>'
        f'<h3 id="{title_id}">{h(project["title"][lang])}</h3>'
        f'<p>{h(project["description"][lang])}</p></div>'
        f'<aside class="project-rail" aria-label="{rail_label}">'
        f'<span class="verified"><i aria-hidden="true">✓</i> {verified_label}</span>'
        f'<dl>{metadata}<div><dt>{field}</dt><dd>{h(field_label)}</dd></div></dl></aside></article>'
    )


def project_domain_content(data, domain, lang):
    projects = [p for p in data['projects'] if p['verified'] and p['domain'] == domain]
    if projects:
        return ''.join(project_feature(project, lang) for project in projects)
    label = project_directory_label(domain, lang)
    icon = 'gamepad' if domain == 'game-development' else 'chip'
    title = {
        'tr': 'Henüz doğrulanmış, herkese açık bir proje yok.',
        'en': 'No verified public project has been published yet.',
    }[lang]
    description = {
        'tr': 'Bu alandaki topluluk projeleri burada görünecek.',
        'en': 'Community projects in this area will appear here.',
    }[lang]
    genres = {'tr': ('OYUNLAR', 'PROTOTİPLER', 'ARAÇLAR'),
              'en': ('GAMES', 'PROTOTYPES', 'TOOLS')}[lang]
    captions = (''.join(f'<span>{genre}</span>' for genre in genres)
                if domain == 'game-development' else '')
    return (
        '<div class="game-empty"><div class="game-icon" aria-hidden="true">'
        f'<img src="../../assets/illustrations/{icon}.svg" alt=""></div>'
        f'<div><span class="empty-label">{label}</span><h3>{title}</h3><p>{description}</p></div>'
        f'<div class="game-caption" aria-hidden="true">{captions}</div></div>'
    )


def project_site_chrome(lang):
    """Reuse the frozen homepage's static header/footer, with page-aware links."""
    home = (ROOT / 'src' / lang / 'index.html').read_text(encoding='utf-8')
    header = re.search(r'<header class="masthead">.*?</header>', home, re.S).group()
    footer = re.search(r'<footer class="footer">.*?</footer>', home, re.S).group()
    header = header.replace('aria-current="page" class="active" ', '')
    header = header.replace('href="#', 'href="../#')
    header = header.replace(f'<a href="/{lang}/projects/">',
                            '<a aria-current="page" class="active" href="#top">')
    header = header.replace('src="../assets/', 'src="../../assets/')
    for locale in LANGS:
        header = header.replace(f'href="../{locale}/"', f'href="../../{locale}/projects/"')
    return header, footer


def render_projects(data, lang):
    header, footer = project_site_chrome(lang)
    teams = data['teams']
    snippets = {
        'SITE_HEADER': header,
        'SITE_FOOTER': footer,
        'PROJECT_DOMAIN_INDEX': project_domain_index(data, lang),
        'ELECTRONICS_PROJECTS': project_domain_content(data, 'electronics-embedded', lang),
        'GAME_PROJECTS': project_domain_content(data, 'game-development', lang),
        'PROJECT_TEAMS': (
            f'<div data-content-id="{h(teams["id"])}"><p>{h(teams["description"][lang])}</p>'
            f'<a class="small-button" href="{h(teams["url"])}">'
            f'{h(teams["link_label"][lang])} →</a></div>'
        ),
    }
    template = (ROOT / 'src' / lang / 'projects' / 'index.html').read_text(encoding='utf-8')
    for token, snippet in snippets.items():
        marker = '{{' + token + '}}'
        if template.count(marker) != 1:
            raise ValueError(f'{lang} projects template: expected one {marker}')
        template = template.replace(marker, snippet)
    return template


def site_files(data):
    """Assemble the deployment manifest from source only, before touching dist/."""
    files = {
        Path('index.html'): (ROOT / 'src' / 'index.html').read_bytes(),
    }
    for lang in LANGS:
        files[Path(lang) / 'index.html'] = render(data, lang).encode('utf-8')
        files[Path(lang) / 'projects' / 'index.html'] = render_projects(data, lang).encode('utf-8')
    for source in sorted((ROOT / 'styles').rglob('*.css')):
        if source.is_file():
            files[source.relative_to(ROOT)] = source.read_bytes()
    for source in sorted((ROOT / 'assets').rglob('*')):
        if source.is_file():
            files[source.relative_to(ROOT)] = source.read_bytes()
    return files


class PageLinks(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.ids = set()
        self.links = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs:
            self.ids.add(attrs['id'])
        for key in ('href', 'src'):
            if attrs.get(key):
                self.links.append(attrs[key])


def validate_site(files):
    """Check local HTML links/fragments and stylesheet assets within the artifact."""
    pages = {path: PageLinks(body.decode('utf-8')) for path, body in files.items()
             if path.suffix == '.html'}
    references = [(path, link) for path, page in pages.items() for link in page.links]
    for path, body in files.items():
        if path.suffix == '.css':
            references.extend((path, match.group(1).strip(" \"'"))
                              for match in re.finditer(r'url\(([^)]+)\)', body.decode('utf-8')))
    # Resolve against an imaginary deployment root, never the checkout's files.
    base = Path('/site')
    for source, link in references:
        parsed = urlparse(link)
        if parsed.scheme or parsed.netloc:
            continue
        target = unquote(parsed.path)
        if target.startswith('/'):
            absolute = base / target.lstrip('/')
        elif target:
            absolute = base / source.parent / target
        else:
            absolute = base / source
        absolute = absolute.resolve()
        if not absolute.is_relative_to(base):
            raise ValueError(f'{source}: link escapes deployment root: {link}')
        destination = absolute.relative_to(base)
        if destination not in files:
            destination /= 'index.html'
        if destination not in files:
            raise ValueError(f'{source}: missing local target: {link}')
        if parsed.fragment and destination in pages:
            if unquote(parsed.fragment) not in pages[destination].ids:
                raise ValueError(f'{source}: missing local fragment: {link}')


def check_output(files, output):
    if output.is_symlink() or not output.is_dir():
        raise ValueError(f'{output}: missing or invalid build; run python3 scripts/build.py')
    paths = list(output.rglob('*'))
    if any(path.is_symlink() for path in paths):
        raise ValueError(f'{output}: unexpected symlink; rebuild dist/')
    actual = {path.relative_to(output) for path in paths if path.is_file()}
    missing, extra = set(files) - actual, actual - set(files)
    stale = {path for path in set(files) & actual if (output / path).read_bytes() != files[path]}
    if missing or extra or stale:
        details = '; '.join(f'{label}: {", ".join(str(path) for path in sorted(paths))}'
                            for label, paths in [('missing', missing), ('extra', extra), ('stale', stale)] if paths)
        raise ValueError(f'{output}: {details}; run python3 scripts/build.py')


def write_output(files, output):
    # The CLI supplies only ROOT/dist, never a user-selectable source directory.
    # Reject a symlink rather than following it during cleanup or writing.
    if output.is_symlink():
        raise ValueError(f'{output}: refusing to replace a symlink')
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    for path, body in sorted(files.items()):
        destination = output / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--validate', action='store_true', help='validate JSON without building dist/')
    mode.add_argument('--check', action='store_true', help='verify dist/ matches source, including assets and links')
    args = parser.parse_args()
    try:
        data = json.loads((ROOT / 'content/home.json').read_text(encoding='utf-8'))
        validate(data)
        if args.validate:
            print('content/home.json: valid')
            return 0
        files = site_files(data)
        validate_site(files)
        output = ROOT / 'dist'
        if args.check:
            check_output(files, output)
            print('dist/: complete and current; local links and assets valid')
        else:
            write_output(files, output)
            print('Built complete static site in dist/')
    except (OSError, ValueError) as error:
        print(f'Build error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
