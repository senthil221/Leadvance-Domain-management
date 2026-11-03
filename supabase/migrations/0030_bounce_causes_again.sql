-- Re-read every bounce: the server's own error further down newer Microsoft notices
-- is now read (most "policy" were block lists), and "detected as spam" no longer
-- hides what the other server said. The bounce-causes job fills them back in.
update email_events set bounce_cause = null where kind = 'bounce';
