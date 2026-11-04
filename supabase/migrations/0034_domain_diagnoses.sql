-- AI diagnoses of a domain, on request. The facts are kept with the answer so a
-- diagnosis can be checked later, and so unchanged facts don't pay for a second
-- answer. feedback is the person's own call on whether it was right.

create table domain_diagnoses (
  id            serial primary key,
  domain_id     uuid not null references domains(id) on delete cascade,
  created_at    timestamptz not null default now(),
  created_by    text not null,
  model         text,
  facts         jsonb,
  result        jsonb not null,
  input_tokens  integer,
  output_tokens integer,
  feedback      text check (feedback in ('right', 'wrong')),
  feedback_by   text,
  feedback_at   timestamptz
);
create index domain_diagnoses_domain_idx on domain_diagnoses (domain_id, id desc);
alter table domain_diagnoses enable row level security;
