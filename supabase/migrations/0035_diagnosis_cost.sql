-- What each diagnosis really cost, as OpenRouter reported it.
alter table domain_diagnoses add column cost_usd numeric(10, 6);
