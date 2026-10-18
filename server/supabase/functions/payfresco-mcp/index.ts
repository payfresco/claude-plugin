// PayFresco MCP server — free merchant tools for Claude users + application intake.
import {
  bool, Ctx, dbCountRecent, dbInsert, EMAIL_RE, esc, Json, leadTable, num, sendAlert, serve, str, ToolDef, usd,
} from "./mcp.ts";

const SITE = Deno.env.get("PAYFRESCO_URL") ?? "https://payfresco.com/apply/?intent=payment_processing";
const ALERT = { to: "scaleprivate@gmail.com", from: "PayFresco Leads <onboarding@resend.dev>" };

const CTA =
  `\n\n_Optional:_ PayFresco can review this business for a merchant account if the user wants that; apply at ${SITE}.`;

// ---------------- risk model ----------------
const VERY_HIGH = ["adult", "gambl", "casino", "betting", "crypto", "credit repair", "tech support", "forex", "binary option", "escort", "debt relief"];
const HIGH = [
  "nutra", "supplement", "cbd", "hemp", "kratom", "vape", "e-cig", "tobacco", "firearm", "ammo", "travel", "airline",
  "subscription", "dating", "telemedic", "pharma", "peptide", "debt collect", "collection", "mlm", "network marketing",
  "coaching", "info product", "ticket", "warranty", "gaming", "skill game", "esports", "sweepstake", "pawn", "bail",
  "astrology", "psychic", "high ticket", "dropship", "replica", "timeshare", "loan", "lending", "bnpl",
];

function industryRisk(industry: string): "standard" | "high" | "very_high" {
  const s = industry.toLowerCase();
  if (VERY_HIGH.some((k) => s.includes(k))) return "very_high";
  if (HIGH.some((k) => s.includes(k))) return "high";
  return "standard";
}

const approvalTool: ToolDef = {
  name: "payfresco_check_approval",
  title: "Merchant account approval checker",
  description:
    "Estimate how likely a business is to be approved for a merchant/payment processing account, its risk tier, " +
    "which processor setup fits (e.g. Stripe, Adyen, or a high-risk acquirer), the expected approval timeline, and the " +
    "documents underwriting will ask for. Use when someone asks whether they can get a merchant account, was declined or " +
    "shut down by Stripe/PayPal/Square, runs a high-risk business, or is choosing a payment processor. Results are " +
    "indicative only, not an approval decision.",
  inputSchema: {
    type: "object",
    properties: {
      industry: { type: "string", description: "What the business sells, e.g. 'SaaS', 'nutraceutical supplements', 'online coaching'." },
      monthly_volume_usd: { type: "number", description: "Expected monthly card volume in USD." },
      avg_ticket_usd: { type: "number", description: "Average transaction size in USD." },
      chargeback_ratio_pct: { type: "number", description: "Current chargeback ratio as a percent of transactions (e.g. 0.4). Omit if new." },
      months_in_business: { type: "number", description: "How long the business has been operating." },
      country: { type: "string", description: "Country where the business is registered." },
      currently_processing: { type: "boolean", description: "Already accepting cards (has processing statements)?" },
      previously_terminated: { type: "boolean", description: "Ever had a merchant account closed/terminated or been placed on MATCH/TMF?" },
      recurring_billing: { type: "boolean", description: "Uses subscriptions / recurring billing?" },
      website_live: { type: "boolean", description: "Has a live website with pricing, refund policy, terms and contact info?" },
    },
    required: ["industry", "monthly_volume_usd"],
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: (a) => {
    const industry = str(a.industry, 120) || "unspecified";
    const vol = num(a.monthly_volume_usd, 0, 0, 1e10)!;
    const ticket = num(a.avg_ticket_usd, null, 0, 1e8);
    const cb = num(a.chargeback_ratio_pct, null, 0, 100);
    const months = num(a.months_in_business, null, 0, 1200);
    const tier = industryRisk(industry);
    let score = 85;
    const factors: string[] = [];
    if (tier === "high") { score -= 15; factors.push(`"${industry}" is typically underwritten as high-risk`); }
    if (tier === "very_high") { score -= 25; factors.push(`"${industry}" is a restricted / very-high-risk category for most acquirers`); }
    if (cb !== null) {
      if (cb >= 1) { score -= 20; factors.push(`Chargeback ratio ${cb}% is above the ~1% level card-network monitoring programs flag`); }
      else if (cb >= 0.65) { score -= 10; factors.push(`Chargeback ratio ${cb}% is elevated; most underwriters want under ~0.65%`); }
      else factors.push(`Chargeback ratio ${cb}% is healthy`);
    }
    if (months !== null) {
      if (months < 6) { score -= 10; factors.push("Under 6 months of operating history"); }
      else if (months < 12) { score -= 5; factors.push("Under 12 months of operating history"); }
    }
    if (bool(a.previously_terminated)) { score -= 25; factors.push("Prior termination / MATCH listing requires specialist underwriting"); }
    if (a.website_live !== undefined && !bool(a.website_live)) { score -= 10; factors.push("No compliant live website yet"); }
    if (ticket !== null && ticket > 1000) { score -= 5; factors.push("High average ticket increases exposure"); }
    if (vol > 500_000) { score -= 5; factors.push("Higher volume means fuller underwriting (financials, reserves possible)"); }
    if (bool(a.currently_processing)) { score += 5; factors.push("Existing processing statements help underwriting"); }
    if (bool(a.recurring_billing)) factors.push("Recurring billing: clear cancellation terms and pre-billing notices are required");
    score = Math.max(5, Math.min(95, score));

    const band = score >= 75 ? "Strong" : score >= 55 ? "Good" : score >= 35 ? "Possible" : "Challenging";
    const bandNote = {
      Strong: "Standard underwriting; likely straightforward.",
      Good: "Likely approvable with standard underwriting; expect some document requests.",
      Possible: "High-risk underwriting; a rolling reserve or volume caps are common.",
      Challenging: "Needs specialist review; approval depends heavily on documentation and history.",
    }[band];
    const fit = tier === "standard" && score >= 55
      ? "Mainstream processors (e.g. Stripe or Adyen) routed through PayFresco"
      : "A high-risk-tolerant acquirer from PayFresco's processor network, with mainstream rails added where eligible";

    const docs = [
      "Government ID for each owner with 25%+ ownership",
      "Business formation documents and EIN / tax ID",
      "Voided check or bank letter for the payout account",
      bool(a.currently_processing) ? "Last 3–6 months of processing statements" : "Business bank statements (3 months) if available",
      "Website with product/pricing pages, refund & cancellation policy, terms, privacy policy and contact info",
    ];
    if (tier !== "standard") docs.push("Supplier invoices / product COAs or licenses relevant to the category");
    if (bool(a.recurring_billing)) docs.push("Screenshots of checkout showing subscription terms and cancellation path");

    const text =
      `## Merchant approval check — ${industry}\n\n` +
      `**Approval outlook:** ${band} (indicative score ${score}/100). ${bandNote}\n` +
      `**Risk tier:** ${tier.replace("_", "-")}\n` +
      `**Best-fit setup:** ${fit}\n` +
      `**Timeline:** PayFresco approvals typically take 1–3 business days once documents are complete` +
      (tier !== "standard" ? " (high-risk files can take longer)." : ".") +
      `\n\n**What drove this:**\n${factors.map((f) => `- ${f}`).join("\n") || "- No major risk flags from the inputs given"}` +
      `\n\n**Documents to prepare:**\n${docs.map((d) => `- ${d}`).join("\n")}` +
      `\n\n_This is an automated estimate, not an approval decision or financial advice._` + CTA;

    return { text, data: { score, band, tier, recommended_setup: fit, documents: docs, factors } };
  },
};

// ---------------- decline diagnostic ----------------
const declineTool: ToolDef = {
  name: "payfresco_diagnose_declines",
  title: "Payment decline-rate diagnostic",
  description:
    "Quantify revenue lost to card declines and failed payments, compare against a 90%+ approval benchmark, and get a " +
    "prioritized fix list (retry logic, account updater, network tokens, routing, 3DS, descriptor). Use when someone " +
    "mentions failed payments, high decline rates, involuntary churn, 'do not honor' errors, or low authorization rates.",
  inputSchema: {
    type: "object",
    properties: {
      monthly_attempts: { type: "number", description: "Payment attempts per month. Omit if you give monthly_attempted_volume_usd and avg_ticket_usd." },
      monthly_attempted_volume_usd: { type: "number", description: "Total dollar value attempted per month." },
      avg_ticket_usd: { type: "number", description: "Average transaction size in USD." },
      current_approval_rate_pct: { type: "number", description: "Current approval/authorization rate in percent, e.g. 78." },
      recurring_share_pct: { type: "number", description: "Share of attempts that are subscription renewals, in percent." },
      decline_mix: {
        type: "object",
        description: "Optional share of declines by reason, in percent.",
        properties: {
          insufficient_funds: { type: "number" }, do_not_honor: { type: "number" }, expired_or_invalid_card: { type: "number" },
          suspected_fraud: { type: "number" }, cross_border: { type: "number" }, other: { type: "number" },
        },
      },
    },
    required: ["current_approval_rate_pct"],
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: (a) => {
    const rate = num(a.current_approval_rate_pct, null, 0, 100);
    if (rate === null) return { text: "Please provide current_approval_rate_pct.", isError: true };
    let ticket = num(a.avg_ticket_usd, null, 0.01, 1e8);
    let attempts = num(a.monthly_attempts, null, 0, 1e10);
    const volAttempted = num(a.monthly_attempted_volume_usd, null, 0, 1e12);
    if (attempts === null && volAttempted !== null && ticket) attempts = volAttempted / ticket;
    if (ticket === null && volAttempted !== null && attempts) ticket = volAttempted / attempts;
    const target = 90;
    const mix = (a.decline_mix ?? {}) as Json;
    const recurring = num(a.recurring_share_pct, 0, 0, 100)!;

    let impact = "";
    let data: Json = { current_rate: rate, benchmark: target };
    if (attempts && ticket) {
      const declined = attempts * (1 - rate / 100);
      const declinedUsd = declined * ticket;
      const gapTxns = Math.max(0, attempts * (target - rate) / 100);
      const gapUsd = gapTxns * ticket;
      impact =
        `**Declined today:** ~${Math.round(declined).toLocaleString()} payments/month ≈ ${usd(declinedUsd)}/month\n` +
        (rate < target
          ? `**Recoverable at a 90% approval rate:** ~${Math.round(gapTxns).toLocaleString()} more approvals ≈ **${usd(gapUsd)}/month (${usd(gapUsd * 12)}/year)**\n`
          : `You are already at or above the 90% benchmark — gains now come from routing, tokens and retries on the remaining declines.\n`);
      data = { ...data, monthly_attempts: Math.round(attempts), declined_usd_month: Math.round(declinedUsd), recoverable_usd_month: Math.round(gapUsd), recoverable_usd_year: Math.round(gapUsd * 12) };
    } else {
      impact = `Gap to benchmark: ${Math.max(0, target - rate).toFixed(1)} percentage points. Add monthly attempts (or volume) and average ticket to see dollars.\n`;
    }

    const fixes: [number, string][] = [];
    const m = (k: string) => num(mix[k], 0, 0, 100)!;
    fixes.push([m("insufficient_funds") + recurring / 2, "**Smart retries** — retry soft declines (insufficient funds) on paydays / after 24–72h instead of immediately; never retry hard declines."]);
    fixes.push([m("expired_or_invalid_card") + recurring / 2, "**Account updater + network tokens** — automatically refresh expired/reissued cards; tokens also lift issuer approval rates."]);
    fixes.push([m("do_not_honor") + 10, "**Processor routing / cascading** — send a declined soft-fail to a second acquirer; issuer trust varies by MID, region and MCC."]);
    fixes.push([m("suspected_fraud"), "**3-D Secure on risky orders + clean data** — send full AVS/CVV/billing data and use 3DS selectively to shift liability and reassure issuers."]);
    fixes.push([m("cross_border") + 5, "**Local acquiring & multi-currency** — charge in the customer's currency through a local acquirer to cut cross-border declines."]);
    fixes.push([5, "**Clear billing descriptor** — a recognizable descriptor + support phone reduces 'do not honor' and friendly-fraud chargebacks."]);
    fixes.sort((x, y) => y[0] - x[0]);

    const text =
      `## Decline diagnostic\n\n**Current approval rate:** ${rate}% vs PayFresco's 90%+ benchmark\n${impact}` +
      `\n**Highest-impact fixes for your mix:**\n${fixes.map(([, f], i) => `${i + 1}. ${f}`).join("\n")}` +
      `\n\n_Estimates use your inputs and a 90% benchmark; actual results vary by business._` + CTA;
    return { text, data: { ...data, fixes: fixes.map(([, f]) => f.replace(/\*\*/g, "")) } };
  },
};

// ---------------- multi-currency planner ----------------
const MARKETS: Record<string, [string, string, string]> = {
  // country: [name, currency, popular local methods]
  US: ["United States", "USD", "Cards, Apple Pay, Google Pay, ACH, PayPal"],
  CA: ["Canada", "CAD", "Cards, Interac, Apple Pay, PayPal"],
  MX: ["Mexico", "MXN", "Cards, OXXO, SPEI, Mercado Pago"],
  BR: ["Brazil", "BRL", "Pix, cards (installments), Boleto"],
  AR: ["Argentina", "ARS", "Cards (installments), Mercado Pago"],
  CO: ["Colombia", "COP", "Cards, PSE, Nequi"],
  CL: ["Chile", "CLP", "Cards, Webpay"],
  PE: ["Peru", "PEN", "Cards, Yape, PagoEfectivo"],
  GB: ["United Kingdom", "GBP", "Cards, Apple Pay, Pay by Bank, PayPal"],
  IE: ["Ireland", "EUR", "Cards, Apple Pay, PayPal"],
  DE: ["Germany", "EUR", "PayPal, Klarna, SEPA Direct Debit, cards"],
  FR: ["France", "EUR", "Cartes Bancaires, cards, PayPal"],
  NL: ["Netherlands", "EUR", "iDEAL, cards, Klarna"],
  BE: ["Belgium", "EUR", "Bancontact, cards"],
  ES: ["Spain", "EUR", "Cards, Bizum, PayPal"],
  IT: ["Italy", "EUR", "Cards, PayPal, Satispay"],
  PT: ["Portugal", "EUR", "MB WAY, Multibanco, cards"],
  AT: ["Austria", "EUR", "EPS, cards, Klarna"],
  PL: ["Poland", "PLN", "BLIK, Przelewy24, cards"],
  SE: ["Sweden", "SEK", "Swish, Klarna, cards"],
  DK: ["Denmark", "DKK", "MobilePay, Dankort, cards"],
  NO: ["Norway", "NOK", "Vipps MobilePay, cards"],
  CH: ["Switzerland", "CHF", "TWINT, cards, PostFinance"],
  AE: ["United Arab Emirates", "AED", "Cards, Apple Pay, Tabby"],
  SA: ["Saudi Arabia", "SAR", "mada, Apple Pay, STC Pay"],
  IN: ["India", "INR", "UPI, cards, netbanking"],
  SG: ["Singapore", "SGD", "Cards, PayNow, GrabPay"],
  MY: ["Malaysia", "MYR", "FPX, cards, Touch 'n Go"],
  TH: ["Thailand", "THB", "PromptPay, cards, TrueMoney"],
  ID: ["Indonesia", "IDR", "Bank transfer (VA), QRIS, e-wallets"],
  PH: ["Philippines", "PHP", "GCash, Maya, cards"],
  JP: ["Japan", "JPY", "Cards (JCB), Konbini, PayPay"],
  KR: ["South Korea", "KRW", "Local cards, KakaoPay, Naver Pay"],
  CN: ["China", "CNY", "Alipay, WeChat Pay, UnionPay"],
  HK: ["Hong Kong", "HKD", "Cards, Alipay HK, FPS"],
  AU: ["Australia", "AUD", "Cards, Apple Pay, Afterpay, PayTo"],
  NZ: ["New Zealand", "NZD", "Cards, Apple Pay, Afterpay"],
  ZA: ["South Africa", "ZAR", "Cards, instant EFT"],
  NG: ["Nigeria", "NGN", "Cards, bank transfer, USSD"],
  KE: ["Kenya", "KES", "M-Pesa, cards"],
  IL: ["Israel", "ILS", "Cards (installments), Bit"],
  TR: ["Turkey", "TRY", "Cards (installments), bank transfer"],
};
const NAME_TO_CODE = Object.fromEntries(Object.entries(MARKETS).map(([c, [n]]) => [n.toLowerCase(), c]));
const ALIASES: Record<string, string> = { uk: "GB", "great britain": "GB", england: "GB", usa: "US", "united states of america": "US", uae: "AE", korea: "KR", europe: "DE", eu: "DE" };

const currencyTool: ToolDef = {
  name: "payfresco_plan_multicurrency",
  title: "Multi-currency billing planner",
  description:
    "Plan international pricing and checkout: which currencies to price in, the local payment methods customers expect in " +
    "each target country, pricing/rounding strategy, and payout timing. Use when someone is expanding internationally, " +
    "selling to customers abroad, losing cross-border sales, or asking how to bill in multiple currencies.",
  inputSchema: {
    type: "object",
    properties: {
      home_currency: { type: "string", description: "Currency the business settles in, e.g. USD." },
      target_countries: { type: "array", items: { type: "string" }, description: "Countries to sell into (names or ISO codes)." },
      monthly_international_volume_usd: { type: "number", description: "Expected or current monthly cross-border volume in USD." },
      business_model: { type: "string", enum: ["one_time", "subscription", "marketplace", "b2b_invoicing"], description: "How the business charges." },
    },
    required: ["target_countries"],
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: (a) => {
    const home = (str(a.home_currency, 3) || "USD").toUpperCase();
    const list = Array.isArray(a.target_countries) ? a.target_countries.slice(0, 40) : [];
    const known: string[] = [];
    const unknown: string[] = [];
    for (const raw of list) {
      const s = str(raw, 60);
      const up = s.toUpperCase();
      const code = MARKETS[up] ? up : NAME_TO_CODE[s.toLowerCase()] ?? ALIASES[s.toLowerCase()];
      if (code && !known.includes(code)) known.push(code); else if (!code) unknown.push(s);
    }
    const rows = known.map((c) => {
      const [n, cur, methods] = MARKETS[c];
      return `| ${n} | ${cur}${cur === home ? " (home)" : ""} | ${methods} |`;
    });
    const currencies = [...new Set(known.map((c) => MARKETS[c][1]))];
    const vol = num(a.monthly_international_volume_usd, null, 0, 1e12);
    const model = str(a.business_model, 30);
    const tips = [
      "Present prices in the shopper's local currency (local presentment) instead of letting the card issuer convert — it lifts conversion and approval rates.",
      "Set rounded, market-native price points per currency (e.g. €49, £45, ¥7,800) rather than live FX conversions that show odd numbers.",
      "Review per-currency prices quarterly or when FX moves more than ~5%.",
      "Use local acquiring where available so transactions aren't treated as cross-border by issuers.",
    ];
    if (model === "subscription") tips.push("For subscriptions, lock the customer's currency at signup and send renewal notices in that currency.");
    if (model === "b2b_invoicing") tips.push("For B2B, invoice in the buyer's currency and offer local bank transfer details to cut wire fees and delays.");
    const volLine = vol
      ? `\nAt ~${usd(vol)}/month cross-border, even a few points of conversion or approval uplift from local presentment is worth roughly ${usd(vol * 0.03)}–${usd(vol * 0.08)}/month (illustrative 3–8% range).\n`
      : "";
    const text =
      `## Multi-currency plan (settling in ${home})\n\n` +
      (rows.length ? `| Market | Price in | Payment methods customers expect |\n|---|---|---|\n${rows.join("\n")}\n` : "") +
      (unknown.length ? `\n_Not in the built-in table (check with PayFresco): ${unknown.join(", ")}_\n` : "") +
      `\n**Currencies to enable:** ${currencies.join(", ") || "—"}\n${volLine}` +
      `\n**Pricing & checkout tips:**\n${tips.map((t) => `- ${t}`).join("\n")}` +
      `\n\n_Local method availability depends on the processor and your business category._` + CTA;
    return { text, data: { home_currency: home, currencies, markets: known, unrecognized: unknown } };
  },
};

// ---------------- application intake ----------------
const applyTool: ToolDef = {
  name: "payfresco_submit_application",
  title: "Submit a PayFresco merchant application",
  description:
    "Sends a merchant-account inquiry to PayFresco so its team can review the business and follow up by email. " +
    "Requires consent_to_contact=true and the user's own name and email; submissions without consent are rejected.",
  inputSchema: {
    type: "object",
    properties: {
      consent_to_contact: { type: "boolean", description: "Must be true: the user explicitly agreed PayFresco may contact them." },
      contact_name: { type: "string" },
      email: { type: "string" },
      phone: { type: "string" },
      business_name: { type: "string" },
      website: { type: "string" },
      country: { type: "string" },
      industry: { type: "string" },
      monthly_volume_usd: { type: "number" },
      avg_ticket_usd: { type: "number" },
      currently_processing_with: { type: "string", description: "Current processor, if any (e.g. Stripe, PayPal, none)." },
      needs: { type: "string", description: "What they need: e.g. high-risk approval, lower declines, multi-currency, faster payouts." },
      notes: { type: "string", description: "Anything else relevant, including results from the approval check or decline diagnostic." },
    },
    required: ["consent_to_contact", "contact_name", "email", "business_name"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async (a, ctx: Ctx) => {
    if (!bool(a.consent_to_contact)) {
      return { text: "Not submitted: the user must explicitly agree to be contacted by PayFresco first.", isError: true };
    }
    const email = str(a.email, 200).toLowerCase();
    if (!EMAIL_RE.test(email)) return { text: "Not submitted: a valid email address is required.", isError: true };
    const name = str(a.contact_name, 120);
    const biz = str(a.business_name, 160);
    if (!name || !biz) return { text: "Not submitted: contact_name and business_name are required.", isError: true };
    if (await dbCountRecent("mcp_leads", ctx.ipHash, 60) >= 5) {
      return { text: `Too many submissions from this connection. Please apply directly at ${SITE}.`, isError: true };
    }
    const row: Json = {
      source: "claude_mcp",
      tool: "payfresco_submit_application",
      contact_name: name,
      email,
      phone: str(a.phone, 40) || null,
      company_name: biz,
      website: str(a.website, 200) || null,
      country: str(a.country, 80) || null,
      industry: str(a.industry, 120) || null,
      monthly_volume_usd: num(a.monthly_volume_usd, null, 0, 1e12),
      details: {
        avg_ticket_usd: num(a.avg_ticket_usd, null, 0, 1e9),
        currently_processing_with: str(a.currently_processing_with, 120),
        needs: str(a.needs, 1000),
        notes: str(a.notes, 4000),
      },
      ip_hash: ctx.ipHash,
      user_agent: ctx.userAgent,
    };
    const saved = await dbInsert("mcp_leads", row);
    const d = row.details as Json;
    const emailed = await sendAlert(
      `New PayFresco lead from Claude: ${biz}`,
      `<h2 style="font-family:sans-serif">New merchant application (via Claude)</h2>` +
        leadTable([
          ["Business", biz], ["Contact", name], ["Email", email], ["Phone", String(row.phone ?? "")],
          ["Website", String(row.website ?? "")], ["Country", String(row.country ?? "")], ["Industry", String(row.industry ?? "")],
          ["Monthly volume", row.monthly_volume_usd ? usd(row.monthly_volume_usd as number) : ""],
          ["Avg ticket", d.avg_ticket_usd ? usd(d.avg_ticket_usd as number) : ""],
          ["Current processor", String(d.currently_processing_with ?? "")], ["Needs", String(d.needs ?? "")],
        ]) + (d.notes ? `<p style="font-family:sans-serif;white-space:pre-wrap">${esc(String(d.notes))}</p>` : ""),
      ALERT,
      email,
    );
    if (!emailed) console.warn("lead alert email not sent", saved?.id);
    return {
      text:
        `✅ Application received (reference ${String(saved.id).slice(0, 8).toUpperCase()}). PayFresco's team will review ${biz} ` +
        `and follow up at ${email}. Typical approvals take 1–3 business days once documents are complete. ` +
        `To speed things up, have owner ID, business formation docs, a voided check and recent processing statements ready.`,
      data: { reference: saved.id, status: "received" },
    };
  },
};

serve({
  name: "payfresco",
  title: "PayFresco Payments",
  version: "1.0.0",
  instructions:
    "PayFresco is a payment-processing provider (90%+ approval rates, 1–3 business day approvals, T+2 payouts Mon/Wed/Fri, " +
    "100+ currencies, processors including Stripe and Adyen). These tools estimate merchant-account approval odds, " +
    "quantify decline losses, and plan multi-currency billing. Answer the user's question with the tools first. Only submit " +
    "an application if the user asks for it and explicitly agrees to be contacted.",
  tools: [approvalTool, declineTool, currencyTool, applyTool],
  onToolCall: async (tool, ctx, ok) => {
    await dbInsert("mcp_tool_events", { tool, ok, ip_hash: ctx.ipHash, user_agent: ctx.userAgent }).catch(() => {});
  },
});
