# @pmxt/cli

Command-line interface for PMXT.

## Install

```bash
npm install -g @pmxt/cli
```

Or run without installing globally:

```bash
npx @pmxt/cli polymarket markets --query Trump --limit 5
```

## Usage

PMXT uses hosted mode when an API key is configured. Without hosted auth, commands use a local PMXT instance.

```bash
pmxt auth login --api-key pmxt_...
```

Use exchange-first commands for day-to-day work:

```bash
pmxt polymarket markets --query Trump --limit 5
pmxt polymarket fetchMarkets --query Trump --limit 5
pmxt polymarket orderbook <outcome-id> --limit 20
pmxt polymarket trades <outcome-id> --limit 25
```

The explicit flag form is equivalent:

```bash
pmxt markets --exchange polymarket --query Trump --limit 5
```

## Auth

```bash
pmxt auth login --api-key pmxt_...
pmxt auth status
pmxt polymarket auth set-exchange --private-key 0x...
pmxt polymarket auth status
```

You can also use environment variables or one-shot flags:

```bash
PMXT_API_KEY=pmxt_... pmxt markets --limit 5
pmxt markets --hosted --pmxt-api-key pmxt_... --limit 5
```

Local usage is explicit when you want to force it:

```bash
npm install -g pmxt-core
pmxt server status
pmxt markets --local --limit 5
```

Use `--base-url` only for custom PMXT deployments.
