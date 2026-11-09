// Enhance the static, localized event cards. Archived records never reach this document.
(() => {
    const panel = document.querySelector('.upcoming-panel');
    const calendar = document.querySelector('.calendar-panel');
    if (!panel || !calendar) return;
    const cards = [...panel.querySelectorAll('.event-entry')];
    const groups = [...panel.querySelectorAll('[data-event-group]')];
    const controls = [...document.querySelectorAll('[data-mode]')];
    const empty = panel.querySelector('[data-empty-state]');
    let mode = 'upcoming';
    const siteDate = () => {
        const values = Object.fromEntries(
            new Intl.DateTimeFormat('en', {
                timeZone: 'Europe/Istanbul',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            })
                .formatToParts(new Date())
                .map((part) => [part.type, part.value]),
        );
        return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
    };
    function renderCalendar() {
        const today = siteDate();
        const monthNames = JSON.parse(calendar.dataset.monthNames);
        const title = `${monthNames[today.month - 1]} ${today.year}`;
        calendar.querySelector('h2').textContent = title;
        calendar.querySelector('table').setAttribute('aria-label', title);
        const dates = new Map();
        for (const card of cards) {
            const day = card.dataset.calendarDate;
            dates.set(day, [...(dates.get(day) || []), card.dataset.eventTitle]);
        }
        const tbody = calendar.querySelector('tbody');
        tbody.replaceChildren();
        const offset = (new Date(Date.UTC(today.year, today.month - 1, 1)).getUTCDay() + 6) % 7;
        const days = new Date(Date.UTC(today.year, today.month, 0)).getUTCDate();
        let marked = false;
        for (let index = 0; index < Math.ceil((offset + days) / 7) * 7; index++) {
            if (index % 7 === 0) tbody.append(document.createElement('tr'));
            const cell = document.createElement('td');
            const day = index - offset + 1;
            if (day > 0 && day <= days) {
                const key = `${today.year}-${String(today.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const span = document.createElement('span');
                span.textContent = String(day);
                if (day === today.day) {
                    cell.classList.add('today');
                    span.setAttribute('aria-current', 'date');
                }
                if (dates.has(key)) {
                    marked = true;
                    cell.classList.add('has-event');
                    span.setAttribute('aria-label', `${day}: ${dates.get(key).join('; ')}`);
                }
                cell.append(span);
            }
            tbody.lastElementChild.append(cell);
        }
        calendar.querySelector('.calendar-legend span').textContent = marked
            ? calendar.dataset.legendMarked
            : calendar.dataset.legendEmpty;
    }
    function render() {
        const now = Date.now();
        for (const group of groups) {
            const past = group.dataset.eventGroup === 'past';
            const selected = cards
                .filter((card) => Number(card.dataset.startMs) < now === past)
                .sort(
                    (a, b) =>
                        (Number(a.dataset.startMs) - Number(b.dataset.startMs)) * (past ? -1 : 1),
                );
            group.replaceChildren(...selected);
            group.hidden = mode !== group.dataset.eventGroup || !selected.length;
        }
        const selected = groups.find((group) => group.dataset.eventGroup === mode);
        const isEmpty = !selected.querySelector('.event-entry');
        empty.hidden = !isEmpty;
        panel.querySelector('.panel-status').hidden = !isEmpty;
        const past = mode === 'past';
        panel.querySelector('h2 span').textContent = past
            ? panel.dataset.pastLabel
            : panel.dataset.upcomingLabel;
        panel.querySelector('.empty-copy h3').textContent = past
            ? panel.dataset.pastNotice
            : panel.dataset.notice;
        panel.querySelector('.empty-copy p').textContent = past
            ? panel.dataset.pastDescription
            : panel.dataset.description;
        for (const control of controls)
            control.setAttribute('aria-pressed', String(control.dataset.mode === mode));
        renderCalendar();
    }
    for (const control of controls)
        control.addEventListener('click', () => {
            mode = control.dataset.mode;
            render();
        });
    render();
    // Keep start-time classification and calendar context current on long-lived tabs.
    setInterval(render, 60000);
})();
