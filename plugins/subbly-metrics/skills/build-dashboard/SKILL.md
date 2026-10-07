---
name: build-dashboard
description: Build, update or rebuild a subscription metrics dashboard (MRR, ARR, MRR movements, churn, cohorts, cash flow, failed charges, past-due customers) for the user's Subbly store, published as a private artifact in their own Claude account and wired to their own Subbly connector. Use when the user asks for a Subbly dashboard, MRR or churn dashboard, ChartMogul-style metrics for their Subbly store, or to update an existing Subbly metrics dashboard.
---

# Build a Subbly metrics dashboard

The result is an artifact in the user's own Claude account. The page pulls the store's data through the user's own Subbly connector, keeps a compact copy in the artifact's own database, and works out every metric in the browser. Store data never passes through this conversation: you only build and publish the page.

The template is in `template/` beside this file, and `scripts/prepare.mjs` fills it in. Use both as they are; do not edit the template's code.

## 1. Find the Subbly connector

The page calls Subbly through one connector, named exactly as Claude knows it. Find it in this session:

- A **claude.ai connector**: one whose tools include `list_invoices`, `list_subscriptions`, `list_customers` and `list_transactions`. Its display name (for example `Subbly` or `subbly-my-store`) is the connector name. The `artifact-capabilities` skill lists this session's connectors by display name.
- A **local MCP server** in the user's Claude Code config (tool names `mcp__<name>__list_invoices`): the connector name is `host:<name>`. Tell the user that this only works for them, in the Claude desktop app, and that adding Subbly as a claude.ai connector makes the dashboard work in a browser too.

If there are several Subbly connectors (an agency with many stores), ask which store this dashboard is for. If there is none, tell the user to add their Subbly connector in claude.ai Settings → Connectors, and stop.

Check the connector answers with two one-row reads: `list_invoices` and `list_customers`, each with `perPage: 1`. Read only `pagination.total` from each result. Do not list or repeat customer details.

## 2. Confirm the details with the user

Ask in one message:

- **Store name** as it should appear on the dashboard. Suggest one from the connector name.
- **Lock screen** (optional): a password the dashboard asks for before showing anything. It keeps casual viewers out but is not security; real access is the artifact's sharing settings. If they want one, they type it in their reply.

Also tell them the store's size (invoices and customers) and that the first pull takes about 1 minute per 1,000 invoices, once.

## 3. Prepare the page

Run the script with the user's answers. Put the output in the current project, in `subbly-dashboard-<store>`:

```bash
SUBBLY_DASHBOARD_PASSWORD='<password, only if they want a lock>' node "<this skill's directory>/scripts/prepare.mjs" --name "<Store name>" --connector "<connector name>" --out "./subbly-dashboard-<store-slug>"
```

Leave `SUBBLY_DASHBOARD_PASSWORD` out entirely when they want no lock. The script prints JSON with `file_path`, `files`, `capabilities`, `title` and `existing_url`. A rerun with the same `--out` keeps the name, connector, storage key, lock and link from the first run, so later updates only need `--out`.

## 4. Publish the artifact

Before publishing, load the `artifact-capabilities` skill if this session has not loaded it. Then publish with the Artifact tool:

- `file_path`: the script's `file_path`
- `files`: the script's `files`, exactly (`{"engine.js": "<path>"}`)
- `capabilities`: the script's `capabilities`, exactly
- `url`: the script's `existing_url` when it is not null, so an update keeps the same link and stored data
- `icon`: `chart`, on the first publish only
- `description`: one sentence, for example "Subscription metrics for <Store>, pulled from Subbly and stored with the dashboard."

Then record the link so the next update reuses it:

```bash
node "<this skill's directory>/scripts/prepare.mjs" --out "./subbly-dashboard-<store-slug>" --record-url "<published link>"
```

## 5. Hand over

Tell the user, briefly:

1. Open the link and press **Pull data from Subbly**. Claude asks once to let the page use their Subbly connector.
2. After the first pull, the dashboard opens instantly. It catches up by itself when opened more than 6 hours after the last refresh, and the Refresh button catches up on demand.
3. The dashboard is private to them. It can be shared only with people in their own organization, from the page's Share menu, and never publicly.

You cannot press the pull button for them; the connector consent belongs to the person viewing the page.

## Updating an existing dashboard

When the user asks to update or rebuild their dashboard (for example after this plugin updates), rerun step 3 with the same `--out`, then step 4 with `url` set. Stored data survives a republish, so no new pull is needed. To change the store name, connector or password, pass the new value; `--no-lock` removes the lock screen.

## Do not

- Do not pull store data into this conversation to build or test the dashboard. The page pulls it.
- Do not put store data, customer names or figures into the page source.
- Do not change the storage key of a published dashboard; its stored data lives under that key.
