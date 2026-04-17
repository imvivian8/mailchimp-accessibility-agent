# Accessibility Audit — Full Site

Run a full Mailchimp WCAG 2.1 AA accessibility + usability audit across all pages.

## What this does

Crawls all ~25 Mailchimp page types and runs axe-core accessibility checks on each one. Produces two reports:

1. **Markdown report** — per-page violations with WCAG criteria references and a compliance checklist
2. **Visual HTML report** — color-coded violations (critical = red, serious = orange) with screenshots, affected HTML elements, and a summary sorted by severity

## Steps

1. Make sure you have dependencies installed: `npm install` in `mailchimp-accessibility-agent/`
2. Make sure Chrome is open and you're logged into Mailchimp
3. Run from the `mailchimp-accessibility-agent/` directory:

```bash
export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" && node audit.mjs
```

4. When complete, open the visual report:
```bash
open reports/a11y_visual_$(date +%Y-%m-%d).html
```

## Scope options

To audit specific sections only:
```bash
node audit.mjs --sections=audience,campaigns,settings
```

To audit just the current page:
```bash
node audit.mjs --page
```

## What gets checked

- **WCAG 2.1 A**: Alt text on images, keyboard accessibility, form labels, semantic structure
- **WCAG 2.1 AA**: Color contrast, page language, headings, input labels
- **Best practices**: Nested interactive controls, ARIA usage, button names, link names
- **Usability**: Vague CTAs, unlabeled form inputs, heading hierarchy gaps
