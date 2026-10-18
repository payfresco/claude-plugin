-- Leads + anonymous usage events from the PayFresco Claude plugin / MCP connector.
-- Service-role only: RLS on, no policies (the edge function writes with the service role key).
create table if not exists public.mcp_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null default 'claude_mcp',
  tool text not null,
  status text not null default 'new' check (status in ('new','contacted','qualified','won','lost','spam')),
  contact_name text not null,
  email text not null,
  phone text,
  company_name text not null,
  website text,
  country text,
  industry text,
  monthly_volume_usd numeric,
  details jsonb not null default '{}'::jsonb,
  ip_hash text,
  user_agent text
);
comment on table public.mcp_leads is 'Merchant applications submitted via the PayFresco Claude connector (payfresco_submit_application).';
create index if not exists mcp_leads_created_idx on public.mcp_leads (created_at desc);
create index if not exists mcp_leads_ip_recent_idx on public.mcp_leads (ip_hash, created_at desc);
alter table public.mcp_leads enable row level security;

create table if not exists public.mcp_tool_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  tool text not null,
  ok boolean not null default true,
  ip_hash text,
  user_agent text
);
comment on table public.mcp_tool_events is 'Anonymous usage counter for PayFresco Claude connector tools (no inputs stored).';
create index if not exists mcp_tool_events_created_idx on public.mcp_tool_events (created_at desc);
alter table public.mcp_tool_events enable row level security;
