-- "author" names the owner as the sender of a message sent through the App API; no project may have that slug.
-- Stops the upgrade with a clear message instead of a bare CHECK violation in the next migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM projects WHERE id = 'author') THEN
    RAISE EXCEPTION 'the project slug "author" is reserved for messages sent by the owner, but a project "author" exists: move its content to another project and delete it, then upgrade';
  END IF;
END $$;
