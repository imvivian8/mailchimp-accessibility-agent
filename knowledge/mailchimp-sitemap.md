# Mailchimp Sitemap — Page Manifest for UX Audit

This file lists the distinct page types to audit. The agent navigates to each route and runs the per-page audit procedure. For pages requiring a specific entity (e.g., a campaign report), the agent should navigate to the listing page first and click into the first available item.

The base URL pattern is `https://<datacenter>.admin.mailchimp.com` (e.g., `us21.admin.mailchimp.com`). The agent should detect the correct base URL from the currently open Mailchimp tab.

---

## Dashboard
| Page | Route | Notes |
|------|-------|-------|
| Marketing Dashboard | `/` or `/home` | Main dashboard with aggregate metrics. High priority for tooltip audit. |

## Campaigns — Email
| Page | Route | Notes |
|------|-------|-------|
| All Campaigns | `/campaigns` | Campaign listing with status, open rate, click rate columns |
| Campaign Report (Email) | `/reports/summary?id=<ID>` | Navigate from listing → click first campaign. Key page for metric tooltips. |
| Campaign Report — Click Map | `/reports/click-performance?id=<ID>` | Click performance details |
| Campaign Report — E-commerce | `/reports/ecommerce?id=<ID>` | Revenue, orders, conversion metrics |
| Campaign Report — Social | `/reports/social?id=<ID>` | Social sharing metrics |
| Create Campaign | `/campaigns/wizard/*` | Campaign creation wizard — check for help text and field labels |

## Audience
| Page | Route | Notes |
|------|-------|-------|
| Audience Dashboard | `/audience/` | Audience growth, engagement metrics overview |
| All Contacts | `/audience/contacts` | Contact listing — check column header clarity |
| Contact Profile | `/audience/contacts/detail?id=<ID>` | Navigate from contacts list → click first contact |
| Segments | `/audience/segments` | Segment listing and conditions |
| Tags | `/audience/tags` | Tag management |
| Signup Forms | `/audience/signup-forms` | Form builder — check field labels, accessibility |
| Audience Analytics | `/audience/analytics` | Growth rate, engagement trends |

## Automations
| Page | Route | Notes |
|------|-------|-------|
| Automations Overview | `/automations` | Automation listing with performance summaries |
| Customer Journeys | `/customer-journey/` | Journey builder — complex UI, high usability audit value |
| Automation Report | Navigate from listing → click first automation | Automation-specific metrics |

## Content
| Page | Route | Notes |
|------|-------|-------|
| Content Studio | `/content/` | File management — check alt text, media accessibility |
| Brand Kit | `/brand/` | Brand settings |

## Analytics
| Page | Route | Notes |
|------|-------|-------|
| Analytics Overview | `/analytics/` | Cross-channel analytics dashboard |
| Revenue Analytics | `/analytics/revenue` | E-commerce metrics — high priority for tooltips |
| Email Analytics | `/analytics/email` | Aggregate email performance metrics |

## Settings
| Page | Route | Notes |
|------|-------|-------|
| Account Settings | `/account/` | Account management |
| Billing | `/account/billing/` | Billing and plan info |
| Connected Sites | `/account/connected-sites/` | E-commerce integrations |
| Users | `/account/users/` | Team member management |

## Website
| Page | Route | Notes |
|------|-------|-------|
| Landing Pages | `/landing-pages/` | Landing page listing |
| Website Builder | `/website/` | Website builder — complex UI |

---

## Navigation Strategy

1. **Detect base URL**: Read the current tab URL to extract the datacenter prefix (e.g., `us21`)
2. **For listing pages**: Navigate directly to the route
3. **For detail pages** (Campaign Report, Contact Profile, Automation Report): Navigate to the parent listing page first, use `find()` to locate the first clickable item, click into it
4. **SPA transitions**: After each navigation, wait 2 seconds, then verify content has loaded by checking for the absence of loading spinners and presence of main content
5. **Retry logic**: If a page doesn't load after 3 attempts, log the failure and move to the next page
6. **Permission gates**: Some pages may require specific plan tiers. If a paywall or upgrade prompt appears, note it and skip.
