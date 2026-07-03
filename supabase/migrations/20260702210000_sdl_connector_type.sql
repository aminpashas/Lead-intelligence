-- Allow a Smile Design Lab connector config per org.
-- Re-adds the whitelist with every type live on prod ('ghl' from the GHL pull
-- sync, 'carestack' from the EHR work) so this is safe whichever order
-- branches land in.
ALTER TABLE connector_configs DROP CONSTRAINT IF EXISTS connector_configs_connector_type_check;
ALTER TABLE connector_configs ADD CONSTRAINT connector_configs_connector_type_check CHECK (connector_type IN (
  'google_ads', 'meta_capi', 'ga4', 'outbound_webhook', 'slack',
  'google_reviews', 'callrail', 'ghl', 'carestack', 'smile_design_lab'
));
