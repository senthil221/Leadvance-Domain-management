-- A domain with a campaign limit comes in from Smartlead as active even when
-- it is still warming up, so people can put it back.
insert into domain_transitions (from_status, to_status) values ('active', 'warming') on conflict do nothing;
