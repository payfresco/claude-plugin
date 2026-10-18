# PayFresco for Claude

Free payment-processing tools inside Claude, plus a one-step application to PayFresco.

| Tool | What it does |
|---|---|
| **Merchant approval checker** | Approval outlook, risk tier, best-fit processor setup and the documents underwriting will ask for |
| **Decline-rate diagnostic** | Dollars lost to declines vs a 90% approval benchmark, plus a fix list prioritized for your decline mix |
| **Multi-currency planner** | Which currencies to price in, the local payment methods each market expects, price-point strategy |
| **Apply to PayFresco** | With your permission, sends your details to PayFresco for review |

**Why PayFresco:** 90%+ transaction approval rates · approval typically in 1–3 business days · T+2 payouts every Mon/Wed/Fri · billing in 100+ currencies · unlimited volume potential · Stripe, Adyen and more.

## Install

**Claude.ai / Claude Desktop (any plan with custom connectors)**
Settings → Connectors → *Add custom connector*
- Name: `PayFresco`
- URL: `https://ilwhtirvdiwfrzlbqsvp.supabase.co/functions/v1/payfresco-mcp`

**Claude Code / Cowork (plugin with skills)**
```
/plugin marketplace add payfresco/claude-plugin
/plugin install payfresco@payfresco
```

Then just ask: *"Stripe shut down my supplement store. Can I get approved somewhere else?"*

## Privacy
Full policy: https://payfresco.com/privacy.html

The calculator code does not save the business inputs you provide. Tool-usage records include the tool name, success status, timestamp, a hash derived from the request IP address, and the user-agent string. Contact and application details are saved and sent to PayFresco only when you explicitly ask Claude to submit an application and consent to contact.
