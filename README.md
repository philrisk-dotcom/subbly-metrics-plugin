# Subbly Metrics for Claude Code

A Claude Code plugin that builds a subscription metrics dashboard for your Subbly store: MRR and ARR, MRR movements, churn, retention cohorts, cash collected, failed charges and past-due customers, by any date range and by day, week, month, quarter or year.

The dashboard is an artifact in your own Claude account. It reads your store through your own Subbly connector and keeps its data in the artifact's own storage. Subbly never sees your figures, and the dashboard can only be shared inside your organization.

## What you need

- Claude Code, signed in with your claude.ai account
- Your Subbly MCP connector added in claude.ai Settings → Connectors

## Install

In Claude Code:

```
/plugin marketplace add philrisk-dotcom/subbly-metrics-plugin
/plugin install subbly-metrics@subbly-claude-plugins
```

## Use

Ask Claude: **"Build my Subbly metrics dashboard."** Claude finds your Subbly connector, confirms your store name, optionally sets a lock-screen password, and gives you a link. Open it and press **Pull data from Subbly**.

To update the dashboard after a plugin update, ask: **"Update my Subbly dashboard."** It keeps the same link and stored data.

## Layout

```
.claude-plugin/marketplace.json          the marketplace (this repo)
plugins/subbly-metrics/
  .claude-plugin/plugin.json             the plugin
  skills/build-dashboard/SKILL.md        what Claude does
  skills/build-dashboard/template/       the dashboard page and metrics engine
  skills/build-dashboard/scripts/prepare.mjs   fills the template for one store
```
