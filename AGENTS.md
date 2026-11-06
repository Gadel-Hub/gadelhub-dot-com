# AGENTS.md

## Project

This repository is the website for the **GTÜ Game Development & Electronics Community**.

The community has two equal technical domains: **game development** and **electronics / embedded systems**. Neither is secondary.

The GitHub repository is the source of truth.

## Core Rules

- Prefer semantic HTML, CSS, and vanilla JavaScript.
- Do not add frameworks, package managers, CMSs, databases, backends, or large dependency stacks unless explicitly requested.
- Keep changes scoped to the requested task.
- Preserve Turkish/English bilingual readiness.
- Keep game development and electronics equally represented.
- Prefer real community work over generic promotional content.
- Do not fabricate projects, events, statistics, partners, screenshots, or achievements.
- Reuse existing patterns before inventing new ones.

## Primary Visual Reference

The main visual reference is:

`docs/reference/homepage-concept.png`

Inspect it before substantial work involving layout, typography, color, spacing, components, responsive behavior, or overall visual direction.

Treat it as the **visual north star**, not a pixel-perfect specification. Adapt it to real content, responsive layouts, accessibility, maintainable HTML/CSS, and different page types.

When visual decisions are ambiguous, prefer the reference image over inventing a new aesthetic.

## Visual Identity

Target style:
- Modern editorial layout with pixel-art / retro-computing influence
- Cream / off-white background
- Deep navy / near-black structural elements
- Red, orange, and blue accents derived from the logo
- Hard rectangular geometry, strong borders, and dividers
- Bold display typography; pixel/display fonts used selectively
- Large project screenshots, hardware photos, and illustrations
- Clear hierarchy and generous spacing

The retro influence is an accent, not a literal imitation of an old game UI.

Avoid:
- Generic SaaS styling
- Purple/blue cyberpunk gamer gradients
- Glassmorphism
- Excessive rounded cards or pills
- Neon glow everywhere
- Giant empty hero sections
- Fake metrics or decorative fake charts
- Generic stock imagery
- Futuristic HUD clutter
- Generic AI/startup copy
- One bland card pattern reused for every content type

The site should feel like a real technical student community that builds things.

## Brand Assets

Keep production assets separate from references.

Recommended:

```text
assets/logo/gadel-hub-logo.jpeg
docs/reference/homepage-concept.png
```

Do not crop production assets out of the concept image. The concept image is design guidance only.

## Information Architecture

Preferred top-level sections:
- Home
- Projects
- Events
- Resources
- Teams / Collaboration
- About
- Join

The homepage should quickly answer:
1. Who are we?
2. What are members making?
3. What is happening soon?
4. What useful things are available this week?
5. How can someone join or collaborate?

A likely homepage hierarchy is: header → hero → featured project → projects → this week → events → collaboration → footer.

Do not create a top-level page for every small content category.

## Domain Balance

Game-development content may include games, jams, engines, graphics, art/assets, audio, programming, game design, and tools.

Electronics / embedded content may include STM32 and other MCUs, firmware, PCBs, sensors, controllers, digital electronics, hardware tools, workshops, and open-source hardware.

Hybrid hardware/game projects are especially relevant.

Do not split the site into two unrelated mini-sites unless explicitly requested.

## Technical Architecture

Default implementation:
- Static HTML
- CSS
- Vanilla JavaScript
- Structured JSON or YAML content where useful
- GitHub-based maintenance

Prefer HTML that remains meaningful if JavaScript fails. Use JavaScript for enhancement, filtering, language behavior, lightweight rendering, and small interactions.

Do not turn the site into a client-side application without explicit approval.

A reasonable repository shape is:

```text
/
├── AGENTS.md
├── README.md
├── docs/reference/
├── assets/logo/
├── src/
├── content/
├── scripts/
└── public/
```

This is guidance, not a required structure. Do not add complexity merely to match it.

## Structured Content

Repeated content should preferably live in structured data rather than duplicated markup.

Example:

```json
{
    "id": "stm32-workshop-2026-11",
    "date": "2026-11-21T16:00:00+03:00",
    "location": "GTÜ",
    "title": {
        "tr": "STM32 Atölyesi",
        "en": "STM32 Workshop"
    },
    "description": {
        "tr": "STM32 ile gömülü sistemlere giriş.",
        "en": "An introduction to embedded systems with STM32."
    },
    "tags": ["electronics", "embedded", "workshop"]
}
```

Store language-independent fields once. Use stable IDs. Do not duplicate whole records solely for localization.

## Localization

The site must support Turkish (`tr`) and English (`en`).

Preferred static URL shape:

```text
/tr/...
/en/...
```

Visible user-facing text should be localizable. Language switching should preserve the current page where practical.

Do not silently machine-translate community copy unless explicitly requested.

Even if early content is mostly Turkish, architecture must not make English an afterthought.

## Content and Updates

Community-owned content includes projects, GTÜ events, workshops, team listings, announcements, and guides. Humans should edit this deliberately.

External/changing content may include game jams, free games, free assets, game-development tools, electronics resources, libraries, and open-source projects.

Automation may discover or refresh external content, but should not publish it blindly.

Preferred flow:

```text
fetch/update
→ validate
→ generate changes
→ human review
→ merge
→ deploy
```

Prefer pull requests over silent auto-publishing.

Small maintenance scripts are encouraged when they reduce repetitive work. Python is a good default.

## Code Style

Keep code simple and readable for student maintainers.

### HTML
- 4-space indentation
- Semantic elements where practical
- Logical heading hierarchy
- `kebab-case` class names
- Links for navigation, buttons for actions
- Avoid unnecessary wrappers

### CSS
- Use custom properties for design tokens
- Centralize palette, typography, spacing, borders, and sizing
- Prefer mobile-first responsive rules
- Avoid `!important` unless justified
- Reuse existing tokens/components
- Preserve hard rectangular geometry

### JavaScript
- Prefer modern vanilla JavaScript
- Prefer `const`; use `let` when mutation is required
- Avoid unnecessary global state
- Keep DOM manipulation small and explicit
- Do not add dependencies without a clear need
- Fail gracefully when optional data is unavailable

## Responsive Design and Accessibility

Mobile should be intentionally designed, not merely compressed desktop.

Maintain:
- No horizontal overflow
- Usable navigation
- Sensible typography scaling
- Grids that stack or simplify
- Usable touch targets
- Important content on small screens

Accessibility baseline:
- Semantic HTML
- Keyboard navigation
- Visible focus states
- Useful alt text
- Sufficient contrast
- Proper form labels
- No meaning conveyed by color alone
- Respect `prefers-reduced-motion`

## Copy and Media

Prefer real project screenshots, hardware photos, illustrations, and community work over decorative filler.

Do not present generated placeholders as real community work.

Copy should be direct, specific, friendly, technical where useful, playful in moderation, and concise.

Avoid corporate mission-statement language, empty hype, generic startup wording, unsupported claims, and filler such as “empowering creators.”

## Agent Behavior

Before editing:
1. Inspect the relevant existing files.
2. Inspect `docs/reference/homepage-concept.png` when visual work is involved.
3. Identify and reuse existing layout, component, style, and content patterns.
4. Check whether localization or structured content is affected.

While editing:
- Make the smallest coherent change that solves the task.
- Preserve existing architecture unless change is justified.
- Reuse existing components and design tokens.
- Do not perform unrelated refactors.
- Do not reorganize large parts of the repository without reason.
- Do not add frameworks or dependencies without explicit approval.
- Do not silently change the visual language.
- Do not remove bilingual support.
- Do not privilege game development over electronics or vice versa.
- Do not fabricate content.

After editing:
- Validate affected content.
- Check relevant links and paths.
- Check both languages when localization is affected.
- Check desktop and mobile behavior when layout changes.
- Summarize what changed and note important follow-up.

## Visual Decision Priority

When making visual decisions, use this order:

1. Existing implemented design, if already approved
2. `docs/reference/homepage-concept.png`
3. Existing design tokens/components
4. This file
5. New invention

Do not redesign the site as part of an unrelated task.

## Final Rule

Preserve the site's **identity, simplicity, and maintainability**.

This is a **game development and electronics community website** — not a SaaS dashboard, corporate landing page, esports brand, or framework showcase.

Build the smallest thing that feels intentional, distinctive, and maintainable.
