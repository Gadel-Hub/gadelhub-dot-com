/* Browser regression against dist/. Requires an existing Playwright installation.
 * PLAYWRIGHT_MODULE may point to its module; CHROMIUM_PATH may select cached Chromium.
 * PUBLIC_QA_REPORT optionally persists evidence. No dependencies are installed here.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dist = path.resolve(__dirname, '../dist');
const pages = ['', 'projects', 'events', 'resources', 'teams', 'about', 'join'];
const headings = {
    tr: [
        'OYUN GELİŞTİR. DONANIM ÜRET. BİRLİKTE YAP.',
        'PROJELER',
        'ETKİNLİKLER',
        'KAYNAKLAR',
        'TAKIMLAR',
        'HAKKIMIZDA',
        'KATIL',
    ],
    en: [
        'BUILD GAMES. BUILD HARDWARE. BUILD THINGS.',
        'PROJECTS',
        'EVENTS',
        'RESOURCES',
        'TEAMS',
        'ABOUT',
        'JOIN',
    ],
};
const route = (lang, page) => `/${lang}/${page ? page + '/' : ''}`;
const normalize = (text) => text.replace(/\s+/g, ' ').trim();
const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
};
const server = http.createServer((req, res) => {
    try {
        let file = path.resolve(
            dist,
            '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname),
        );
        assert.ok(file.startsWith(dist + path.sep));
        if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
        res.writeHead(200, {
            'Content-Type': types[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        res.end(fs.readFileSync(file));
    } catch {
        res.writeHead(404);
        res.end('Not found');
    }
});

async function identity(page, lang, target) {
    assert.equal(new URL(page.url()).pathname, route(lang, target));
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await page.locator('h1').count(), 1);
    assert.equal(
        normalize(await page.locator('h1').textContent()),
        headings[lang][pages.indexOf(target)],
    );
}

async function hit(page, href, selector = '.masthead a') {
    return page.evaluate(
        ({ href, selector }) => {
            const anchor = [...document.querySelectorAll(selector)].find(
                (a) => a.getAttribute('href') === href && a.getBoundingClientRect().width > 0,
            );
            if (!anchor) throw new Error(`Missing visible link: ${href}`);
            const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
            const ranges = [];
            while (walker.nextNode()) {
                const node = walker.currentNode;
                if (!node.textContent.trim()) continue;
                const range = document.createRange();
                range.setStart(node, node.textContent.search(/\S/));
                range.setEnd(node, node.textContent.trimEnd().length);
                ranges.push(...range.getClientRects());
            }
            const rect = ranges.sort((a, b) => b.width - a.width)[0];
            const x = rect.x + rect.width / 2,
                y = rect.y + rect.height / 2;
            const top = document.elementFromPoint(x, y)?.closest('a');
            return {
                text: anchor.textContent.trim().replace(/\s+/g, ' '),
                href,
                x,
                y,
                anchorRect: anchor.getBoundingClientRect().toJSON(),
                matched: top === anchor,
                topHref: top?.getAttribute('href'),
                stack: document.elementsFromPoint(x, y).map((e) => ({
                    tag: e.tagName,
                    class: e.className,
                    href: e.getAttribute('href'),
                })),
            };
        },
        { href, selector },
    );
}

(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let browser;
    const evidence = { routes: [], clicks: [], languages: [], semantics: [], errors: [] };
    try {
        browser = await chromium.launch({
            ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
            args: ['--no-sandbox'],
        });
        for (const [width, height] of [
            [1672, 941],
            [3840, 2160],
            [390, 844],
        ]) {
            for (const lang of ['tr', 'en']) {
                for (const source of pages) {
                    const context = await browser.newContext({
                        viewport: { width, height },
                        deviceScaleFactor: 1,
                        serviceWorkers: 'block',
                    });
                    const page = await context.newPage();
                    page.on('pageerror', (error) => evidence.errors.push(error.message));
                    page.on('response', (r) => {
                        if (r.status() >= 400) evidence.errors.push(`${r.status()} ${r.url()}`);
                    });
                    const response = await page.goto(base + route(lang, source), {
                        waitUntil: 'load',
                    });
                    assert.equal(response.status(), 200);
                    assert.equal(response.request().redirectedFrom(), null);
                    await identity(page, lang, source);
                    const reload = await page.reload({ waitUntil: 'load' });
                    assert.equal(reload.status(), 200);
                    assert.equal(reload.request().redirectedFrom(), null);
                    await identity(page, lang, source);
                    await page.evaluate(() => document.fonts.ready);
                    evidence.routes.push({
                        lang,
                        source,
                        width,
                        status: 200,
                        reload: 200,
                        redirects: 0,
                    });
                    const semantics = await page.evaluate(() => {
                        const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
                        const display = document.querySelector('.page-display,.hero-display');
                        return {
                            overflow: document.documentElement.scrollWidth > innerWidth,
                            duplicateIds: ids.filter((id, i) => ids.indexOf(id) !== i),
                            lang: document.documentElement.lang,
                            decorativeHidden:
                                !display || display.getAttribute('aria-hidden') === 'true',
                            positiveTabindex: document.querySelectorAll(
                                '[tabindex]:not([tabindex="0"]):not([tabindex="-1"])',
                            ).length,
                        };
                    });
                    assert.equal(semantics.overflow, false);
                    assert.deepEqual(semantics.duplicateIds, []);
                    assert.equal(semantics.lang, lang);
                    assert.ok(semantics.decorativeHidden);
                    assert.equal(semantics.positiveTabindex, 0);
                    await page.keyboard.press('Tab');
                    const focus = await page.evaluate(() => ({
                        tag: document.activeElement.tagName,
                        style: getComputedStyle(document.activeElement).outlineStyle,
                        width: getComputedStyle(document.activeElement).outlineWidth,
                    }));
                    assert.equal(focus.tag, 'A');
                    assert.notEqual(focus.style, 'none');
                    assert.notEqual(focus.width, '0px');
                    evidence.semantics.push({ lang, source, width, ...semantics, focus });
                    for (const target of pages) {
                        await page.goto(base + route(lang, source), { waitUntil: 'load' });
                        await page.evaluate(() => document.fonts.ready);
                        const selector =
                            target === 'join' && width > 700
                                ? '.header-shell > .join'
                                : '.masthead nav a';
                        const point = await hit(page, route(lang, target), selector);
                        assert.ok(
                            point.matched,
                            JSON.stringify({ lang, source, target, width, ...point }),
                        );
                        const [navigation] = await Promise.all([
                            page.waitForNavigation({ waitUntil: 'load' }),
                            page.mouse.click(point.x, point.y),
                        ]);
                        assert.equal(navigation.status(), 200);
                        assert.equal(navigation.request().redirectedFrom(), null);
                        await identity(page, lang, target);
                        evidence.clicks.push({
                            lang,
                            source,
                            target,
                            width,
                            ...point,
                            finalPath: new URL(page.url()).pathname,
                        });
                    }
                    await page.goto(base + route(lang, source), { waitUntil: 'load' });
                    await page.evaluate(() => document.fonts.ready);
                    const other = lang === 'tr' ? 'en' : 'tr';
                    const switchPoint = await hit(page, route(other, source), '.languages a');
                    assert.ok(switchPoint.matched);
                    const switchAnchor = page.locator(`.languages a[lang="${other}"]`);
                    assert.equal(await switchAnchor.getAttribute('hreflang'), other);
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'load' }),
                        page.mouse.click(switchPoint.x, switchPoint.y),
                    ]);
                    await identity(page, other, source);
                    evidence.languages.push({ source, width, from: lang, to: other });
                    await context.close();
                }
            }
        }
        // Negative control: a correct href must not hide an intercepted physical target.
        const page = await browser.newPage({ viewport: { width: 3840, height: 2160 } });
        await page.goto(base + '/tr/projects/');
        await page.evaluate(() => document.fonts.ready);
        const resources = await hit(page, '/tr/resources/', '.masthead nav a');
        await page.evaluate(({ x, y }) => {
            const blocker = document.createElement('a');
            blocker.href = '/tr/';
            blocker.style.cssText = `position:fixed;left:${x - 5}px;top:${y - 5}px;width:10px;height:10px;z-index:9999;opacity:0`;
            document.body.append(blocker);
        }, resources);
        const blocked = await hit(page, '/tr/resources/', '.masthead nav a');
        assert.equal(blocked.matched, false);
        assert.equal(blocked.topHref, '/tr/');
        evidence.overlayNegativeControl = 'detected';
        assert.deepEqual(evidence.errors, []);
        if (process.env.PUBLIC_QA_REPORT)
            fs.writeFileSync(
                process.env.PUBLIC_QA_REPORT,
                JSON.stringify(evidence, null, 2) + '\n',
            );
        console.log(
            JSON.stringify({
                directRouteAndReloadCases: evidence.routes.length,
                physicalNavClicks: evidence.clicks.length,
                physicalLanguageSwitches: evidence.languages.length,
                semanticAndKeyboardChecks: evidence.semantics.length,
                overlayNegativeControl: evidence.overlayNegativeControl,
                errors: evidence.errors,
            }),
        );
    } finally {
        if (browser) await browser.close();
        await new Promise((resolve) => server.close(resolve));
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
