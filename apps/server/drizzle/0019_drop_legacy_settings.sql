-- The shared token and the connector secret are gone; their last-use indicators with them.
DELETE FROM settings WHERE key IN ('legacy_token_last_used', 'connector_secret_last_used', 'legacy_tracking_since');
