-- Custom SQL migration file, put your code below! --
INSERT INTO projects (id, name, description)
VALUES ('global', 'Global', 'Rules and notes that apply to every project.')
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION tabula_protect_global() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN
    IF OLD.id = 'global' THEN
      RAISE EXCEPTION 'project "global" cannot be deleted';
    END IF;
    RETURN OLD;
  END $$;
--> statement-breakpoint
CREATE TRIGGER projects_protect_global
  BEFORE DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION tabula_protect_global();
