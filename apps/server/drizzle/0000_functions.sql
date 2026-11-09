-- Custom SQL migration file, put your code below! --
CREATE OR REPLACE FUNCTION tabula_tags_text(tags text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT coalesce(array_to_string(tags, ' '), '') $$;
