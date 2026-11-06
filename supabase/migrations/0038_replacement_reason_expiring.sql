-- Replacing a domain because it's about to expire, not because it performs badly.
alter type replacement_reason add value if not exists 'expiring';
