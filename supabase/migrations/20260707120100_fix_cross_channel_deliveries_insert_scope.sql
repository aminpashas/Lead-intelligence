-- Fix: the cross_channel_deliveries INSERT policy was `WITH CHECK (true)` with no
-- `TO service_role`, so it applied to the public/authenticated role too — any
-- logged-in user of org A could insert delivery rows attributed to org B
-- (data poisoning / fabricated delivery history). This is the same class the
-- 20260603 service-role-scope sweep fixed; this table was missed.
--
-- The service client uses the service_role key, which bypasses RLS entirely, so
-- restricting the policy to service_role does not affect legitimate writes.

DROP POLICY IF EXISTS "service_role_insert_deliveries" ON public.cross_channel_deliveries;

CREATE POLICY "service_role_insert_deliveries" ON public.cross_channel_deliveries
  FOR INSERT
  TO service_role
  WITH CHECK (true);
