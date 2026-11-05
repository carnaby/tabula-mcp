-- Custom SQL migration file, put your code below! --
-- Search ignores diacritics: "tabula" is the "simple" configuration (no stemming, records mix Slovak and English) with every
-- word passed through unaccent first. It must exist before the generated search columns of the next migration use it.
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE TEXT SEARCH CONFIGURATION tabula (COPY = simple);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION tabula
  ALTER MAPPING FOR word, hword, hword_part, numword, numhword, hword_numpart WITH unaccent, simple;
