#!/usr/bin/env node

/**
 * Mailchimp Accessibility Audit Agent
 *
 * Crawls your Mailchimp account and identifies WCAG 2.1 AA accessibility
 * violations and usability issues. Produces:
 *
 *   1. A structured markdown report with per-page findings
 *   2. A visual HTML report with screenshots and highlighted violations
 *
 * Usage:
 *   node audit.mjs                    # Full audit (all pages)
 *   node audit.mjs --page             # Audit current page only
 *   node audit.mjs --sections=audience,campaigns
 *
 * Output:
 *   reports/a11y_audit_YYYY-MM-DD.md
 *   reports/a11y_visual_YYYY-MM-DD.html
 *   reports/screenshots/
 */

import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function today() {
  return new Date().toISOString().split("T")[0];
}

function loadSitemap() {
  const raw = readFileSync(
    join(__dirname, "knowledge", "mailchimp-sitemap.md"),
    "utf-8"
  );
  const pages = [];
  const tableRowRe = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/;
  let currentSection = "";

  for (const line of raw.split("\n")) {
    if (line.startsWith("## ") && !line.includes("Navigation Strategy")) {
      currentSection = line.replace("## ", "").trim();
    }
    const match = line.match(tableRowRe);
    if (match) {
      const [, pageName, rawRoute, notes] = match;
      if (pageName === "Page" || pageName.includes("---") || rawRoute.includes("---")) continue;
      const route = rawRoute.trim().replace(/`/g, "").split(" or ")[0].trim();
      if (!route.startsWith("/")) continue;
      pages.push({
        section: currentSection,
        name: pageName.trim(),
        route,
        notes: notes.trim(),
        needsEntity: route.includes("<ID>"),
      });
    }
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Accessibility scan
// ---------------------------------------------------------------------------

const WCAG_CRITERIA = {
  "image-alt": "1.1.1 Non-text Content",
  "button-name": "4.1.2 Name, Role, Value",
  "link-name": "4.1.2 Name, Role, Value",
  "label": "1.3.1 Info and Relationships",
  "select-name": "1.3.1 Info and Relationships",
  "aria-required-attr": "4.1.2 Name, Role, Value",
  "aria-valid-attr-value": "4.1.2 Name, Role, Value",
  "aria-hidden-focus": "4.1.2 Name, Role, Value",
  "color-contrast": "1.4.3 Contrast (Minimum)",
  "html-has-lang": "3.1.1 Language of Page",
  "landmark-one-main": "2.4.1 Bypass Blocks",
  "page-has-heading-one": "2.4.6 Headings and Labels",
  "list": "1.3.1 Info and Relationships",
  "listitem": "1.3.1 Info and Relationships",
  "nested-interactive": "4.1.2 Name, Role, Value",
  "svg-img-alt": "1.1.1 Non-text Content",
};

async function runAxeAudit(page) {
  try {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "best-practice"])
      .analyze();

    return results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      helpUrl: v.helpUrl,
      wcag: WCAG_CRITERIA[v.id] || "WCAG 2.1",
      nodes: v.nodes.slice(0, 5).map((n) => ({
        html: n.html.substring(0, 200),
        target: n.target,
        failureSummary: n.failureSummary?.substring(0, 150) || "",
      })),
    }));
  } catch (err) {
    console.error(`    axe-core error: ${err.message}`);
    return [];
  }
}

async function scanUsability(page) {
  const issues = [];

  // Vague CTAs
  const vagueLabels = ["click here", "learn more", "submit", "read more", "view", "details"];
  for (const label of vagueLabels) {
    try {
      const buttons = await page
        .locator(`button, a, [role="button"]`)
        .filter({ hasText: new RegExp(`^${label}$`, "i") })
        .all();
      for (const btn of buttons.slice(0, 3)) {
        const text = await btn.textContent().catch(() => "");
        issues.push({
          issue: `Vague CTA: "${text.trim()}"`,
          element: await btn.evaluate((e) => e.outerHTML.substring(0, 150)).catch(() => "unknown"),
          recommendation: `Replace with descriptive text, e.g. "View campaign report" instead of "${text.trim()}"`,
          severity: "Minor",
        });
      }
    } catch { /* continue */ }
  }

  // Inputs without labels
  try {
    const inputs = await page.locator("input, select, textarea").all();
    for (const input of inputs.slice(0, 20)) {
      const hasLabel = await input.evaluate((e) => {
        const id = e.id;
        if (id && document.querySelector(`label[for="${id}"]`)) return true;
        if (e.closest("label")) return true;
        if (e.getAttribute("aria-label") || e.getAttribute("aria-labelledby")) return true;
        return false;
      });
      if (!hasLabel) {
        const desc = await input.evaluate(
          (e) => `${e.tagName.toLowerCase()}[type=${e.type || "text"}] placeholder="${e.placeholder || "none"}"`
        ).catch(() => "input");
        issues.push({
          issue: "Form input without accessible label",
          element: desc,
          recommendation: "Add a <label> element or aria-label attribute",
          severity: "Major",
        });
      }
    }
  } catch { /* continue */ }

  // Heading hierarchy gaps
  try {
    const gaps = await page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"));
      const levels = headings.map((h) => parseInt(h.tagName[1]));
      const gaps = [];
      for (let i = 1; i < levels.length; i++) {
        if (levels[i] - levels[i - 1] > 1) {
          gaps.push(`h${levels[i - 1]} → h${levels[i]} (skipped h${levels[i - 1] + 1})`);
        }
      }
      return gaps;
    });
    for (const gap of gaps) {
      issues.push({
        issue: `Heading hierarchy gap: ${gap}`,
        element: "document structure",
        recommendation: "Ensure headings follow sequential order without gaps",
        severity: "Minor",
      });
    }
  } catch { /* continue */ }

  return issues;
}

// ---------------------------------------------------------------------------
// Per-page audit
// ---------------------------------------------------------------------------

async function auditPage(page, name, url) {
  const result = { name, url, axeViolations: [], usabilityIssues: [], screenshotPath: null, error: null };

  try {
    const screenshotDir = join(__dirname, "reports", "screenshots");
    mkdirSync(screenshotDir, { recursive: true });
    const safeName = name.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
    const screenshotPath = join(screenshotDir, `${safeName}_${today()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    result.screenshotPath = screenshotPath;

    console.log(`    🔎 Running axe-core accessibility scan...`);
    result.axeViolations = await runAxeAudit(page);
    console.log(`    Found ${result.axeViolations.length} accessibility violations`);

    console.log(`    🔎 Scanning for usability issues...`);
    result.usabilityIssues = await scanUsability(page);
    console.log(`    Found ${result.usabilityIssues.length} usability issues`);

    console.log(`    ✅ Done\n`);
  } catch (err) {
    console.log(`    ❌ Error: ${err.message}\n`);
    result.error = err.message;
  }

  return result;
}

// ---------------------------------------------------------------------------
// HTML visual report
// ---------------------------------------------------------------------------

function imageToBase64(imagePath) {
  if (!imagePath || !existsSync(imagePath)) return null;
  const buffer = readFileSync(imagePath);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

const IMPACT_COLOR = {
  critical: "#C53030",
  serious: "#C05621",
  moderate: "#B7791F",
  minor: "#2F855A",
};
const IMPACT_BG = {
  critical: "#FFF5F5",
  serious: "#FFFAF0",
  moderate: "#FFFFF0",
  minor: "#F0FFF4",
};

function generateVisualReport(pageResults) {
  // Aggregate totals
  let totalCritical = 0, totalSerious = 0, totalModerate = 0, totalMinor = 0;
  for (const pr of pageResults) {
    for (const v of pr.axeViolations) {
      if (v.impact === "critical") totalCritical++;
      else if (v.impact === "serious") totalSerious++;
      else if (v.impact === "moderate") totalModerate++;
      else totalMinor++;
    }
  }
  const totalA11y = totalCritical + totalSerious + totalModerate + totalMinor;
  const totalUsability = pageResults.reduce((s, pr) => s + pr.usabilityIssues.length, 0);

  // Unique violations across all pages
  const violationCounts = {};
  for (const pr of pageResults) {
    for (const v of pr.axeViolations) {
      if (!violationCounts[v.id]) violationCounts[v.id] = { ...v, pages: [] };
      violationCounts[v.id].pages.push(pr.name);
    }
  }

  // Summary rows sorted by impact
  const impactOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const summaryRows = Object.values(violationCounts)
    .sort((a, b) => impactOrder[a.impact] - impactOrder[b.impact])
    .map((v) => `<tr>
      <td><span class="impact-badge" style="background:${IMPACT_BG[v.impact]};color:${IMPACT_COLOR[v.impact]}">${v.impact}</span></td>
      <td><strong>${v.description}</strong><br><span class="wcag-tag">${v.wcag}</span></td>
      <td>${v.pages.length}</td>
      <td class="pages-list">${v.pages.join(", ")}</td>
      <td><a href="${v.helpUrl}" target="_blank">axe docs →</a></td>
    </tr>`)
    .join("");

  // Page cards
  const pageCards = pageResults
    .filter((pr) => !pr.error && (pr.axeViolations.length > 0 || pr.usabilityIssues.length > 0))
    .map((pr) => {
      const imgData = imageToBase64(pr.screenshotPath);
      const issueCount = pr.axeViolations.length + pr.usabilityIssues.length;

      const violationRows = pr.axeViolations
        .sort((a, b) => impactOrder[a.impact] - impactOrder[b.impact])
        .map((v) => {
          const examples = v.nodes.slice(0, 2).map((n) =>
            `<code class="html-example">${n.html.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`
          ).join("");
          return `<tr>
            <td><span class="impact-badge" style="background:${IMPACT_BG[v.impact]};color:${IMPACT_COLOR[v.impact]}">${v.impact}</span></td>
            <td><strong>${v.description}</strong><br><span class="wcag-tag">${v.wcag}</span><br>${examples}</td>
            <td>${v.nodes.length}</td>
          </tr>`;
        }).join("");

      const usabilityRows = pr.usabilityIssues.map((u) => `<tr>
        <td><span class="impact-badge" style="background:#EDF2F7;color:#4A5568">${u.severity}</span></td>
        <td><strong>${u.issue}</strong><br><code class="html-example">${u.element.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code></td>
        <td>${u.recommendation}</td>
      </tr>`).join("");

      return `
    <section class="page-card" id="page-${pr.name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}">
      <div class="page-header">
        <h2>${pr.name}</h2>
        <span class="url">${pr.url}</span>
        <span class="badge" style="background:#FFF5F5;color:#C53030">${issueCount} issue${issueCount !== 1 ? "s" : ""}</span>
      </div>
      <div class="page-body">
        ${imgData
          ? `<div class="screenshot-container">
               <img src="${imgData}" alt="Screenshot of ${pr.name}" class="page-screenshot" />
             </div>`
          : `<div class="no-screenshot">Screenshot not available</div>`}

        ${pr.axeViolations.length > 0 ? `
        <div class="issue-section">
          <h3>♿ Accessibility Issues (${pr.axeViolations.length})</h3>
          <table class="issue-table">
            <thead><tr><th>Impact</th><th>Issue</th><th># Elements</th></tr></thead>
            <tbody>${violationRows}</tbody>
          </table>
        </div>` : ""}

        ${pr.usabilityIssues.length > 0 ? `
        <div class="issue-section">
          <h3>🎯 Usability Issues (${pr.usabilityIssues.length})</h3>
          <table class="issue-table">
            <thead><tr><th>Severity</th><th>Issue</th><th>Recommendation</th></tr></thead>
            <tbody>${usabilityRows}</tbody>
          </table>
        </div>` : ""}
      </div>
    </section>`;
    }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mailchimp Accessibility Audit — ${today()}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f6fa; color: #2d3748; }

  .report-header { background: #1A365D; color: white; padding: 40px 48px; }
  .report-header h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
  .report-header .subtitle { opacity: 0.8; font-size: 14px; }
  .report-header .meta { margin-top: 24px; display: flex; gap: 16px; flex-wrap: wrap; }
  .report-header .stat { background: rgba(255,255,255,0.12); padding: 12px 20px; border-radius: 8px; min-width: 100px; }
  .report-header .stat .number { font-size: 28px; font-weight: 700; }
  .report-header .stat .label { font-size: 12px; opacity: 0.75; margin-top: 2px; }
  .report-header .stat.critical { background: rgba(197,48,48,0.5); }
  .report-header .stat.serious { background: rgba(192,86,33,0.4); }

  .toc { background: white; border-bottom: 1px solid #e2e8f0; padding: 16px 48px; position: sticky; top: 0; z-index: 100; }
  .toc h2 { font-size: 12px; color: #718096; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
  .toc-links { display: flex; gap: 8px; flex-wrap: wrap; }
  .toc-links a { font-size: 12px; color: #1A365D; text-decoration: none; padding: 4px 10px; background: #EBF4FF; border-radius: 4px; }
  .toc-links a:hover { background: #BEE3F8; }

  .summary-section { max-width: 1400px; margin: 32px auto; padding: 0 48px; }
  .summary-section h2 { font-size: 20px; font-weight: 600; margin-bottom: 16px; color: #1A365D; }

  .impact-badge { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: capitalize; white-space: nowrap; }
  .wcag-tag { font-size: 11px; color: #718096; font-family: monospace; }
  .html-example { display: block; font-size: 11px; background: #f7fafc; padding: 4px 6px; border-radius: 3px; margin-top: 4px; color: #C53030; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 500px; }

  .pages-container { max-width: 1400px; margin: 0 auto 48px; padding: 0 48px; }
  .page-card { background: white; border-radius: 12px; overflow: hidden; margin-bottom: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .page-header { padding: 20px 28px; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .page-header h2 { font-size: 18px; font-weight: 600; }
  .url { font-size: 12px; color: #718096; font-family: monospace; flex: 1; }
  .badge { padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .page-body { padding: 24px 28px; }

  .screenshot-container { margin-bottom: 24px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
  .page-screenshot { display: block; max-width: 100%; height: auto; }
  .no-screenshot { background: #f7fafc; border: 1px dashed #e2e8f0; border-radius: 8px; padding: 32px; text-align: center; color: #718096; margin-bottom: 24px; }

  .issue-section { margin-bottom: 24px; }
  .issue-section h3 { font-size: 15px; font-weight: 600; margin-bottom: 12px; }
  .issue-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .issue-table th { background: #1A365D; color: white; padding: 10px 14px; text-align: left; }
  .issue-table td { padding: 10px 14px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  .issue-table tr:last-child td { border-bottom: none; }
  .issue-table tr:nth-child(even) td { background: #f7fafc; }
  .pages-list { font-size: 12px; color: #4a5568; }

  .summary-table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .summary-table th { background: #1A365D; color: white; padding: 12px 16px; text-align: left; font-size: 13px; }
  .summary-table td { padding: 10px 16px; border-bottom: 1px solid #e2e8f0; font-size: 13px; vertical-align: top; }
  .summary-table tr:last-child td { border-bottom: none; }
  .summary-table tr:nth-child(even) td { background: #f7fafc; }

  @media (max-width: 768px) {
    .report-header, .toc, .summary-section, .pages-container { padding-left: 16px; padding-right: 16px; }
  }
</style>
</head>
<body>

<header class="report-header">
  <h1>Mailchimp Accessibility Audit</h1>
  <div class="subtitle">WCAG 2.1 AA compliance + usability audit</div>
  <div class="meta">
    <div class="stat critical">
      <div class="number">${totalCritical}</div>
      <div class="label">Critical</div>
    </div>
    <div class="stat serious">
      <div class="number">${totalSerious}</div>
      <div class="label">Serious</div>
    </div>
    <div class="stat">
      <div class="number">${totalModerate}</div>
      <div class="label">Moderate</div>
    </div>
    <div class="stat">
      <div class="number">${totalMinor}</div>
      <div class="label">Minor</div>
    </div>
    <div class="stat">
      <div class="number">${totalA11y}</div>
      <div class="label">Total A11y Issues</div>
    </div>
    <div class="stat">
      <div class="number">${totalUsability}</div>
      <div class="label">Usability Issues</div>
    </div>
    <div class="stat">
      <div class="number">${pageResults.length}</div>
      <div class="label">Pages Audited</div>
    </div>
    <div class="stat">
      <div class="number">${today()}</div>
      <div class="label">Audit Date</div>
    </div>
  </div>
</header>

<nav class="toc">
  <h2>Jump to page</h2>
  <div class="toc-links">
    ${pageResults
      .filter((pr) => !pr.error && (pr.axeViolations.length > 0 || pr.usabilityIssues.length > 0))
      .map((pr) => `<a href="#page-${pr.name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}">${pr.name} (${pr.axeViolations.length + pr.usabilityIssues.length})</a>`)
      .join("")}
  </div>
</nav>

<div class="summary-section">
  <h2>All Violations — Sorted by Severity</h2>
  <table class="summary-table">
    <thead>
      <tr>
        <th>Impact</th>
        <th>Violation</th>
        <th># Pages</th>
        <th>Pages Affected</th>
        <th>Reference</th>
      </tr>
    </thead>
    <tbody>
      ${summaryRows}
    </tbody>
  </table>
</div>

<div class="pages-container">
  ${pageCards}
</div>

</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

function generateMarkdownReport(pageResults, startTime) {
  let totalCritical = 0, totalMajor = 0, totalMinor = 0, totalEnhancement = 0;
  let totalUsabilityCritical = 0, totalUsabilityMajor = 0, totalUsabilityMinor = 0;

  for (const pr of pageResults) {
    for (const v of pr.axeViolations) {
      if (v.impact === "critical") totalCritical++;
      else if (v.impact === "serious") totalMajor++;
      else if (v.impact === "moderate") totalMinor++;
      else totalEnhancement++;
    }
    for (const u of pr.usabilityIssues) {
      if (u.severity === "Critical") totalUsabilityCritical++;
      else if (u.severity === "Major") totalUsabilityMajor++;
      else totalUsabilityMinor++;
    }
  }

  const sum = (a, b, c, d) => a + b + c + (d || 0);

  let md = `# Mailchimp Accessibility & Usability Audit Report\n`;
  md += `## Date: ${today()}\n`;
  md += `## Pages Audited: ${pageResults.length}\n`;
  md += `## Duration: ${Math.round((Date.now() - startTime) / 1000 / 60)} minutes\n\n---\n\n`;

  md += `### Executive Summary\n\n`;
  md += `| Category | Critical | Major | Minor | Enhancement | Total |\n`;
  md += `|----------|----------|-------|-------|-------------|-------|\n`;
  md += `| Accessibility (WCAG 2.1 AA) | ${totalCritical} | ${totalMajor} | ${totalMinor} | ${totalEnhancement} | ${sum(totalCritical, totalMajor, totalMinor, totalEnhancement)} |\n`;
  md += `| Usability | ${totalUsabilityCritical} | ${totalUsabilityMajor} | ${totalUsabilityMinor} | 0 | ${sum(totalUsabilityCritical, totalUsabilityMajor, totalUsabilityMinor)} |\n`;
  md += `| **Total** | **${totalCritical + totalUsabilityCritical}** | **${totalMajor + totalUsabilityMajor}** | **${totalMinor + totalUsabilityMinor}** | **${totalEnhancement}** | **${sum(totalCritical, totalMajor, totalMinor, totalEnhancement) + sum(totalUsabilityCritical, totalUsabilityMajor, totalUsabilityMinor)}** |\n\n`;

  md += `---\n\n### Findings by Page\n\n`;

  for (const pr of pageResults) {
    md += `#### ${pr.name} — ${pr.url}\n\n`;
    if (pr.error) { md += `> **Error**: ${pr.error}\n\n`; continue; }

    if (pr.axeViolations.length === 0 && pr.usabilityIssues.length === 0) {
      md += `✅ No issues found.\n\n---\n\n`; continue;
    }

    if (pr.axeViolations.length > 0) {
      md += `**Accessibility Issues (${pr.axeViolations.length})**\n\n`;
      md += `| Impact | Issue | WCAG | # Elements |\n`;
      md += `|--------|-------|------|------------|\n`;
      for (const v of pr.axeViolations) {
        md += `| ${v.impact} | ${v.description} | ${v.wcag} | ${v.nodes.length} |\n`;
      }
      md += `\n`;
    }

    if (pr.usabilityIssues.length > 0) {
      md += `**Usability Issues (${pr.usabilityIssues.length})**\n\n`;
      md += `| Severity | Issue | Recommendation |\n`;
      md += `|----------|-------|----------------|\n`;
      for (const u of pr.usabilityIssues) {
        md += `| ${u.severity} | ${u.issue} | ${u.recommendation} |\n`;
      }
      md += `\n`;
    }

    md += `---\n\n`;
  }

  // WCAG compliance summary
  const allViolationIds = new Set(pageResults.flatMap((pr) => pr.axeViolations.map((v) => v.id)));
  md += `### WCAG 2.1 AA Compliance Summary\n\n`;
  md += `| Criteria | Status | Violations |\n`;
  md += `|----------|--------|------------|\n`;
  const wcagChecks = [
    ["1.1.1 Non-text Content", ["image-alt", "svg-img-alt"]],
    ["1.3.1 Info and Relationships", ["label", "select-name", "list", "listitem"]],
    ["1.4.3 Contrast (Minimum)", ["color-contrast"]],
    ["2.1.1 Keyboard", ["keyboard"]],
    ["2.4.1 Bypass Blocks", ["landmark-one-main"]],
    ["2.4.6 Headings and Labels", ["page-has-heading-one"]],
    ["3.1.1 Language of Page", ["html-has-lang"]],
    ["3.3.2 Labels or Instructions", ["label", "select-name"]],
    ["4.1.2 Name, Role, Value", ["button-name", "link-name", "aria-required-attr", "aria-valid-attr-value", "nested-interactive", "aria-hidden-focus"]],
  ];
  for (const [criteria, ids] of wcagChecks) {
    const failing = ids.filter((id) => allViolationIds.has(id));
    const status = failing.length === 0 ? "✅ Pass" : "❌ Fail";
    md += `| ${criteria} | ${status} | ${failing.join(", ") || "—"} |\n`;
  }

  return md;
}

// ---------------------------------------------------------------------------
// Navigation helper
// ---------------------------------------------------------------------------

async function navigateToPage(page, baseUrl, entry) {
  if (!entry.needsEntity) {
    await page.goto(`${baseUrl}${entry.route}`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    return { url: page.url(), ok: true };
  }

  const listingRoute = entry.route
    .replace(/\?id=<ID>/, "")
    .replace(/\/summary/, "")
    .replace(/\/click-performance/, "")
    .replace(/\/ecommerce/, "")
    .replace(/\/social/, "")
    .replace(/\/detail.*/, "");

  await page.goto(`${baseUrl}${listingRoute}`, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForTimeout(2000);

  const firstLink = await page
    .locator("table tbody tr a, .campaign-list a, [class*='list'] a, a[href*='reports'], a[href*='detail']")
    .first();

  if (await firstLink.isVisible({ timeout: 3000 })) {
    const href = await firstLink.getAttribute("href").catch(() => null);
    if (href) {
      const detailUrl = href.startsWith("http") ? href : `${baseUrl}${href.startsWith("/") ? "" : "/"}${href}`;
      await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(2000);
      return { url: page.url(), ok: true };
    }
  }
  return { url: `${baseUrl}${listingRoute}`, ok: false, error: "No items in listing" };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const singlePage = args.includes("--page");
  const sectionsArg = args.find((a) => a.startsWith("--sections="));
  const allowedSections = sectionsArg
    ? sectionsArg.replace("--sections=", "").split(",").map((s) => s.trim().toLowerCase())
    : null;

  console.log("\n♿ Mailchimp Accessibility Audit Agent\n");
  console.log("This agent runs axe-core WCAG 2.1 AA checks on every Mailchimp page");
  console.log("and produces a visual HTML report of all violations.\n");

  const { spawn, execSync } = await import("child_process");

  try {
    execSync('osascript -e \'tell application "Google Chrome" to quit\'', { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 2000));
  } catch { /* Chrome might not be running */ }

  spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--remote-debugging-port=9222", "--restore-last-session"],
    { detached: true, stdio: "ignore" }
  ).unref();

  console.log("Waiting for Chrome to start...");
  await new Promise((r) => setTimeout(r, 4000));

  let browser, context, page;
  try {
    browser = await chromium.connectOverCDP("http://localhost:9222");
    context = browser.contexts()[0];
    if (!context) throw new Error("No browser context found");

    const pages = context.pages();
    page = pages.find((p) => p.url().includes("admin.mailchimp.com")) ||
           pages.find((p) => p.url().includes("mailchimp.com"));

    if (!page) {
      page = await context.newPage();
      await page.goto("https://login.mailchimp.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
      console.log("\n⏳ Please log in to Mailchimp (90 seconds)...\n");
      for (let s = 90; s > 0; s -= 10) {
        console.log(`   ${s}s remaining...`);
        await new Promise((r) => setTimeout(r, 10000));
      }
    } else {
      console.log(`✅ Found Mailchimp tab: ${page.url()}\n`);
    }
  } catch (err) {
    console.error(`❌ Could not connect to Chrome: ${err.message}`);
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    await page.goto("https://login.mailchimp.com/", { waitUntil: "domcontentloaded" });
    console.log("⏳ 90 seconds to log in + complete OTP.\n");
    for (let s = 90; s > 0; s -= 10) {
      console.log(`   ${s}s remaining...`);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }

  const baseUrl = new URL(page.url()).origin;
  console.log(`✅ Base URL: ${baseUrl}\n`);

  const startTime = Date.now();
  const pageResults = [];

  if (singlePage) {
    console.log(`\n📄 Auditing current page: ${page.url()}\n`);
    pageResults.push(await auditPage(page, "Current Page", page.url()));
  } else {
    const sitemap = loadSitemap();
    const pagesToAudit = allowedSections
      ? sitemap.filter((p) => allowedSections.some((s) => p.section.toLowerCase().includes(s)))
      : sitemap;

    console.log(`📋 Auditing ${pagesToAudit.length} pages...\n`);

    for (let i = 0; i < pagesToAudit.length; i++) {
      const entry = pagesToAudit[i];
      console.log(`[${i + 1}/${pagesToAudit.length}] ${entry.section} > ${entry.name}`);

      try { await page.evaluate(() => document.title); }
      catch {
        const livePage = context.pages().find((p) => { try { return !p.isClosed(); } catch { return false; } });
        page = livePage || await context.newPage();
        console.log(`    🔄 Recovered page`);
      }

      try {
        const nav = await navigateToPage(page, baseUrl, entry);
        if (!nav.ok) {
          pageResults.push({ name: entry.name, url: nav.url, error: nav.error, axeViolations: [], usabilityIssues: [], screenshotPath: null });
          continue;
        }
        pageResults.push(await auditPage(page, entry.name, nav.url));
      } catch (err) {
        console.log(`    ⚠️  ${err.message}`);
        pageResults.push({ name: entry.name, url: `${baseUrl}${entry.route}`, error: err.message, axeViolations: [], usabilityIssues: [], screenshotPath: null });
      }
    }
  }

  // Save reports
  mkdirSync(join(__dirname, "reports"), { recursive: true });

  const mdPath = join(__dirname, "reports", `a11y_audit_${today()}.md`);
  writeFileSync(mdPath, generateMarkdownReport(pageResults, startTime));

  const htmlPath = join(__dirname, "reports", `a11y_visual_${today()}.html`);
  writeFileSync(htmlPath, generateVisualReport(pageResults));

  // Summary
  const totalA11y = pageResults.reduce((s, pr) => s + pr.axeViolations.length, 0);
  const totalUsability = pageResults.reduce((s, pr) => s + pr.usabilityIssues.length, 0);
  const critical = pageResults.reduce((s, pr) => s + pr.axeViolations.filter((v) => v.impact === "critical").length, 0);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`✅ Accessibility audit complete!`);
  console.log(`   Pages audited: ${pageResults.length}`);
  console.log(`   Critical violations: ${critical}`);
  console.log(`   Total accessibility issues: ${totalA11y}`);
  console.log(`   Usability issues: ${totalUsability}`);
  console.log(`\n   📄 Markdown report: ${mdPath}`);
  console.log(`   🎨 Visual HTML report: ${htmlPath}`);
  console.log(`      → Open in browser: open "${htmlPath}"`);
  console.log(`${"=".repeat(60)}\n`);

  await browser.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
