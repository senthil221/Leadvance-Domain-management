-- Microsoft tenant names (*.onmicrosoft.com) were stored as "nameservers not answering" because they have no
-- nameservers of their own. The lookup now judges them by their mail record; clearing the checked date has
-- the next lookup run look at them first.
update domains set nameservers_checked_at = null
where name ~* '\.onmicrosoft\.com$' and nameservers_answering = false;
