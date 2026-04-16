-- Create commercial_leads table for commercial real estate lead intelligence
create table commercial_leads (
  id uuid primary key default gen_random_uuid(),
  acct_number text unique,
  property_address text,
  owner_name text,
  owner_mail_address text,
  year_built int,
  appraised_value numeric,
  property_type text,
  out_of_state_owner boolean,
  permit_flag boolean default false,
  permit_type text,
  permit_status text,
  permit_date date,
  lead_score int,
  status text default 'new',
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_commercial_leads_score on commercial_leads (lead_score desc, status);

create or replace function update_commercial_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger commercial_leads_updated_at
  before update on commercial_leads
  for each row
  execute function update_commercial_updated_at();
