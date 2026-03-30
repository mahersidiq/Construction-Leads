-- Create leads table for construction lead intelligence
create table leads (
  id uuid primary key default gen_random_uuid(),
  acct_number text unique,
  property_address text,
  owner_name text,
  owner_mail_address text,
  year_built int,
  appraised_value numeric,
  unit_count int,
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

-- Index for sorting and filtering leads
create index idx_leads_score_status on leads (lead_score desc, status);

-- Auto-update updated_at on row change
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger leads_updated_at
  before update on leads
  for each row
  execute function update_updated_at();
