#!/usr/bin/env python3
"""Validate homepage JSON and render the two static locale pages."""
import argparse
from datetime import datetime
from html import escape
import json
from pathlib import Path
import re
from urllib.parse import urlparse

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

    for group, fields in (('projects', ('title', 'description')), ('resources', ('title', 'description')), ('items', ('title', 'description'))):
        items = data['projects'] if group == 'projects' else data['week']['resources'] if group == 'resources' else data['events']['items']
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
    if 'platforms' in value and (not isinstance(value['platforms'], list) or not all(isinstance(x, str) for x in value['platforms'])):
        raise ValueError(f'{name}.platforms: expected text list')
    if value.get('end_at') is not None:
        try:
            datetime.fromisoformat(value['end_at'])
        except (TypeError, ValueError):
            raise ValueError(f'{name}.end_at: expected ISO 8601 date') from None


def h(value):
    return escape(value, quote=True)


def render(data, lang):
    f = data['featured']
    featured = (f'\n                    <div class="panel-body"><div class="sample-art" aria-hidden="true">▣<small>{h(f["badge"][lang])}</small></div><div><span class="tag">{h(f["badge"][lang])}</span><h3>{h(f["title"][lang])}</h3><p>{h(f["description"][lang])}</p></div></div>')
    projects = ''.join(f'<div class="project-row"><span class="symbol" aria-hidden="true">{h(p["symbol"])}</span><h3>{h(p["title"][lang])}</h3><p>{h(p["description"][lang])}</p></div>' for p in data['projects'])
    projects = f'\n                    <div class="project-grid">{projects}</div>'
    t = data['teams']
    teams = f'<div class="panel-body"><p>{h(t["description"][lang])}</p><a class="text-link" href="{h(t["url"])}">{h(t["link_label"][lang])} ↗</a></div>'
    w = data['week']
    def resource(item):
        attribution = item.get('external', {}).get('attribution', {})
        credit = (f' <a href="{h(attribution["url"])}">{h(attribution["label"])}</a>'
                  if attribution.get('active_link_required') else '')
        return f'<li><strong><a href="{h(item["url"])}">{h(item["title"][lang])} ↗</a></strong><span>{h(item["description"][lang])}{credit}</span></li>'
    resources = ''.join(resource(item) for item in w['resources'])
    week = f'<div class="panel-body"><p class="empty-note">{h(w["notice"][lang])}</p></div><ul class="list">{resources}</ul>'
    e = data['events']
    if e['items']:
        items = ''.join(f'<li><strong><time datetime="{h(item["date"])}">{h(item["date"])}</time> — {h(item["title"][lang])}</strong><span>{h(item["location"])} · {h(item["description"][lang])}</span></li>' for item in e['items'])
        events = f'<ul class="list">{items}</ul>'
    else:
        events = f'<div class="panel-body"><p class="empty-note"><strong>{h(e["notice"][lang])}</strong></p><p class="muted">{h(e["description"][lang])}</p></div>'
    template = (ROOT / 'src' / lang / 'index.html').read_text()
    snippets = dict(zip(TOKENS, (featured, projects, teams, week, events)))
    for token, html in snippets.items():
        marker = '{{' + token + '}}'
        if template.count(marker) != 1:
            raise ValueError(f'{lang} template: expected one {marker}')
        template = template.replace(marker, html)
    return template


def project_domain_label(domain, lang):
    labels = {
        'game-development': {'tr': 'Oyun geliştirme', 'en': 'Game development'},
        'electronics-embedded': {'tr': 'Elektronik & gömülü', 'en': 'Electronics & embedded'},
    }
    return labels[domain][lang]


def render_projects(data, lang):
    verified = [project for project in data['projects'] if project['verified']]
    sections = []
    empty = {
        'tr': 'Bu alandaki topluluk projeleri burada görünecek.',
        'en': 'Community projects in this area will appear here.',
    }
    for domain in PROJECT_DOMAINS:
        projects = [project for project in verified if project['domain'] == domain]
        cards = ''.join(
            f'<article class="project-page-card"><div class="project-page-symbol" aria-hidden="true">{h(project["symbol"])}</div><div><span class="tag">{h(project_domain_label(domain, lang))}</span><h2>{h(project["title"][lang])}</h2><p>{h(project["description"][lang])}</p></div></article>'
            for project in projects
        )
        content = cards or f'<p class="project-empty">{h(empty[lang])}</p>'
        sections.append(f'<section class="project-domain project-domain--{domain}" aria-labelledby="{domain}"><h2 id="{domain}">{h(project_domain_label(domain, lang))}</h2>{content}</section>')
    template = (ROOT / 'src' / lang / 'projects' / 'index.html').read_text()
    marker = '{{PROJECTS_PAGE}}'
    if template.count(marker) != 1:
        raise ValueError(f'{lang} projects template: expected one {marker}')
    return template.replace(marker, ''.join(sections))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--validate', action='store_true', help='validate JSON without generating pages')
    parser.add_argument('--check', action='store_true', help='fail if generated pages are stale')
    args = parser.parse_args()
    data = json.loads((ROOT / 'content/home.json').read_text())
    validate(data)
    if args.validate:
        print('content/home.json: valid')
        return
    for lang in LANGS:
        pages = ((ROOT / lang / 'index.html', render(data, lang)),
                 (ROOT / lang / 'projects' / 'index.html', render_projects(data, lang)))
        for output, rendered in pages:
            if args.check:
                if not output.exists() or output.read_text() != rendered:
                    raise SystemExit(f'{output}: stale; run python3 scripts/build.py')
            else:
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(rendered)
    print('All static pages are current' if args.check else 'Built home and Projects pages')


if __name__ == '__main__':
    main()
