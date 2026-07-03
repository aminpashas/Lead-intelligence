-- Campaign-level attribution synced from Dion Growth Studio.
--
-- DGS resolves every inbound lead to an exact ad-platform campaign
-- (click-ID → ppc_campaigns match, UTM fallback) in its lead_attributions
-- table. The bridge now forwards that blob so LI can show "Google Ads —
-- <campaign>" instead of a bare "Gohighlevel"/"Whatconverts" source label.
--
-- Shape (all keys optional):
--   { channel, campaign_id, campaign_name, ad_group_id, ad_group_name,
--     keyword_text, click_id_type, attribution_model,
--     attribution_confidence, resolved_at, source_system }
alter table leads add column if not exists campaign_attribution jsonb;

comment on column leads.campaign_attribution is
  'Campaign-level attribution (channel/campaign/ad group/keyword + confidence) resolved by Dion Growth Studio and synced over the /api/v1/leads bridge.';
