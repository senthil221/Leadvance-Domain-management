-- False when the registry delegates the domain to nameservers that don't
-- answer for it (SERVFAIL): the zone is missing at the DNS host, so nothing
-- on the domain resolves. Null until checked.
alter table domains add column nameservers_answering boolean;
