-- ════════════════════════════════════════════════════════════════════════════
-- Area-code → timezone derivation for per-recipient TCPA quiet hours (8am–9pm
-- RECIPIENT-local). Fixes the bug where the SMS quiet-hours gate keys off the ORG
-- timezone (America/Los_Angeles) — wrong for out-of-state leads, where 8pm PT is
-- 11pm ET (a per-message quiet-hours violation).
--
-- For the re-permission pool, `leads.state`/`zip` are empty, so the phone NANP
-- area code is the only available signal. Two known limitations (handled by the
-- conservative fallback below):
--   1. Number portability / people who moved → area code can be wrong.
--   2. This seed is a CURATED STARTER, not the full NANPA list. VERIFY/COMPLETE
--      it against the official NANPA area-code report before production reliance.
-- Unknown OR un-mapped area codes fall through to the cross-zone-safe window, so
-- an incomplete table fails SAFE (sends to fewer leads), never unsafe.
--
-- NOTE ON ENCRYPTION: `leads.phone` / `phone_formatted` are encrypted at rest, so
-- these functions cannot read them directly. Callers pass a PLAINTEXT E.164:
--   • the GHL/LeadConnector send scheduler already has plaintext numbers;
--   • an app-side backfill must decrypt the phone, then UPDATE leads.timezone =
--     phone_area_code_timezone(<e164>).
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.nanp_area_code_timezones (
  area_code  char(3) PRIMARY KEY,
  timezone   text NOT NULL,           -- IANA tz (Arizona = America/Phoenix: no DST)
  note       text
);

-- Curated starter seed — confident single-timezone US area codes only. Split-zone
-- states (IN, KY, TN, parts of TX/FL/MI, etc.) and ambiguous codes are intentionally
-- OMITTED so they hit the conservative fallback rather than risk a wrong map.
INSERT INTO public.nanp_area_code_timezones (area_code, timezone) VALUES
  -- America/New_York (Eastern)
  ('201','America/New_York'),('202','America/New_York'),('203','America/New_York'),
  ('207','America/New_York'),('212','America/New_York'),('215','America/New_York'),
  ('216','America/New_York'),('239','America/New_York'),('267','America/New_York'),
  ('301','America/New_York'),('302','America/New_York'),('305','America/New_York'),
  ('315','America/New_York'),('321','America/New_York'),('330','America/New_York'),
  ('347','America/New_York'),('386','America/New_York'),('401','America/New_York'),
  ('404','America/New_York'),('407','America/New_York'),('410','America/New_York'),
  ('412','America/New_York'),('413','America/New_York'),('434','America/New_York'),
  ('440','America/New_York'),('470','America/New_York'),('475','America/New_York'),
  ('478','America/New_York'),('484','America/New_York'),('508','America/New_York'),
  ('513','America/New_York'),('516','America/New_York'),('518','America/New_York'),
  ('540','America/New_York'),('551','America/New_York'),('561','America/New_York'),
  ('567','America/New_York'),('570','America/New_York'),('571','America/New_York'),
  ('585','America/New_York'),('603','America/New_York'),('607','America/New_York'),
  ('609','America/New_York'),('610','America/New_York'),('614','America/New_York'),
  ('617','America/New_York'),('631','America/New_York'),('646','America/New_York'),
  ('678','America/New_York'),('703','America/New_York'),('704','America/New_York'),
  ('706','America/New_York'),('716','America/New_York'),('717','America/New_York'),
  ('718','America/New_York'),('724','America/New_York'),('727','America/New_York'),
  ('732','America/New_York'),('740','America/New_York'),('754','America/New_York'),
  ('757','America/New_York'),('762','America/New_York'),('770','America/New_York'),
  ('772','America/New_York'),('774','America/New_York'),('781','America/New_York'),
  ('786','America/New_York'),('802','America/New_York'),('803','America/New_York'),
  ('804','America/New_York'),('813','America/New_York'),('814','America/New_York'),
  ('843','America/New_York'),('845','America/New_York'),('848','America/New_York'),
  ('856','America/New_York'),('857','America/New_York'),('860','America/New_York'),
  ('862','America/New_York'),('863','America/New_York'),('864','America/New_York'),
  ('878','America/New_York'),('904','America/New_York'),('908','America/New_York'),
  ('910','America/New_York'),('914','America/New_York'),('917','America/New_York'),
  ('919','America/New_York'),('929','America/New_York'),('937','America/New_York'),
  ('941','America/New_York'),('954','America/New_York'),('959','America/New_York'),
  ('973','America/New_York'),('978','America/New_York'),('980','America/New_York'),
  ('984','America/New_York'),
  -- America/Chicago (Central)
  ('205','America/Chicago'),('210','America/Chicago'),('214','America/Chicago'),
  ('217','America/Chicago'),('225','America/Chicago'),('254','America/Chicago'),
  ('256','America/Chicago'),('281','America/Chicago'),('309','America/Chicago'),
  ('312','America/Chicago'),('314','America/Chicago'),('316','America/Chicago'),
  ('318','America/Chicago'),('331','America/Chicago'),('334','America/Chicago'),
  ('361','America/Chicago'),('402','America/Chicago'),('409','America/Chicago'),
  ('414','America/Chicago'),('417','America/Chicago'),('430','America/Chicago'),
  ('432','America/Chicago'),('469','America/Chicago'),('501','America/Chicago'),
  ('504','America/Chicago'),('512','America/Chicago'),('515','America/Chicago'),
  ('563','America/Chicago'),('573','America/Chicago'),('580','America/Chicago'),
  ('601','America/Chicago'),('608','America/Chicago'),('612','America/Chicago'),
  ('615','America/Chicago'),('618','America/Chicago'),('620','America/Chicago'),
  ('630','America/Chicago'),('636','America/Chicago'),('641','America/Chicago'),
  ('651','America/Chicago'),('660','America/Chicago'),('662','America/Chicago'),
  ('682','America/Chicago'),('708','America/Chicago'),('713','America/Chicago'),
  ('715','America/Chicago'),('731','America/Chicago'),('737','America/Chicago'),
  ('763','America/Chicago'),('769','America/Chicago'),('773','America/Chicago'),
  ('779','America/Chicago'),('785','America/Chicago'),('815','America/Chicago'),
  ('816','America/Chicago'),('817','America/Chicago'),('830','America/Chicago'),
  ('832','America/Chicago'),('847','America/Chicago'),('870','America/Chicago'),
  ('901','America/Chicago'),('903','America/Chicago'),('913','America/Chicago'),
  ('918','America/Chicago'),('920','America/Chicago'),('936','America/Chicago'),
  ('940','America/Chicago'),('952','America/Chicago'),('956','America/Chicago'),
  ('972','America/Chicago'),('979','America/Chicago'),
  -- America/Denver (Mountain, observes DST)
  ('303','America/Denver'),('307','America/Denver'),('385','America/Denver'),
  ('435','America/Denver'),('505','America/Denver'),('575','America/Denver'),
  ('719','America/Denver'),('720','America/Denver'),('801','America/Denver'),
  ('970','America/Denver'),
  -- America/Phoenix (Arizona — NO DST; must be distinct from Denver in summer)
  ('480','America/Phoenix'),('520','America/Phoenix'),('602','America/Phoenix'),
  ('623','America/Phoenix'),('928','America/Phoenix'),
  -- America/Los_Angeles (Pacific)
  ('209','America/Los_Angeles'),('213','America/Los_Angeles'),('279','America/Los_Angeles'),
  ('310','America/Los_Angeles'),('323','America/Los_Angeles'),('408','America/Los_Angeles'),
  ('415','America/Los_Angeles'),('424','America/Los_Angeles'),('442','America/Los_Angeles'),
  ('503','America/Los_Angeles'),('510','America/Los_Angeles'),('530','America/Los_Angeles'),
  ('541','America/Los_Angeles'),('559','America/Los_Angeles'),('619','America/Los_Angeles'),
  ('626','America/Los_Angeles'),('650','America/Los_Angeles'),('657','America/Los_Angeles'),
  ('661','America/Los_Angeles'),('669','America/Los_Angeles'),('702','America/Los_Angeles'),
  ('707','America/Los_Angeles'),('714','America/Los_Angeles'),('725','America/Los_Angeles'),
  ('747','America/Los_Angeles'),('760','America/Los_Angeles'),('775','America/Los_Angeles'),
  ('805','America/Los_Angeles'),('818','America/Los_Angeles'),('831','America/Los_Angeles'),
  ('858','America/Los_Angeles'),('909','America/Los_Angeles'),('916','America/Los_Angeles'),
  ('925','America/Los_Angeles'),('949','America/Los_Angeles'),('951','America/Los_Angeles'),
  ('971','America/Los_Angeles'),
  -- Seattle/WA (Pacific)
  ('206','America/Los_Angeles'),('253','America/Los_Angeles'),('360','America/Los_Angeles'),
  ('425','America/Los_Angeles'),('509','America/Los_Angeles'),('564','America/Los_Angeles'),
  -- Non-contiguous
  ('907','America/Anchorage'),  -- Alaska
  ('808','Pacific/Honolulu')    -- Hawaii (no DST)
ON CONFLICT (area_code) DO UPDATE SET timezone = EXCLUDED.timezone;

-- Resolve a plaintext E.164 (or 10/11-digit) phone → IANA timezone, or NULL if the
-- area code is unknown/un-mapped.
CREATE OR REPLACE FUNCTION public.phone_area_code_timezone(e164 text)
RETURNS text AS $$
DECLARE
  digits text;
  ac     char(3);
BEGIN
  IF e164 IS NULL THEN RETURN NULL; END IF;
  digits := regexp_replace(e164, '\D', '', 'g');         -- strip non-digits
  IF length(digits) = 11 AND left(digits, 1) = '1' THEN
    ac := substr(digits, 2, 3);
  ELSIF length(digits) = 10 THEN
    ac := substr(digits, 1, 3);
  ELSE
    RETURN NULL;                                          -- not a NANP number
  END IF;
  RETURN (SELECT timezone FROM public.nanp_area_code_timezones WHERE area_code = ac);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Fail-safe quiet-hours predicate. TRUE iff it is legal to send NOW (8am–9pm
-- recipient-local). When the area code is unknown, falls back to the CROSS-ZONE
-- SAFE window — only the hours that are 8am–9pm in EVERY continental US zone, which
-- is 11am–9pm Eastern (= 8am–6pm Pacific). So an unmapped lead is never texted
-- outside 8–9 local no matter which US zone they're actually in.
--
-- This is the LEGAL FLOOR. Operationally, prefer a buffer (e.g. 9am–8pm) at the
-- scheduler to absorb DST edges and area-code/portability error.
CREATE OR REPLACE FUNCTION public.sms_send_allowed_now(
  e164 text,
  at_ts timestamptz DEFAULT now()
)
RETURNS boolean AS $$
DECLARE
  tz   text;
  hr   int;
BEGIN
  tz := public.phone_area_code_timezone(e164);
  IF tz IS NOT NULL THEN
    hr := extract(hour FROM (at_ts AT TIME ZONE tz));
    RETURN hr >= 8 AND hr < 21;                           -- 8:00am–8:59pm local
  END IF;
  -- Unknown area code → conservative cross-zone window (11am–9pm ET).
  hr := extract(hour FROM (at_ts AT TIME ZONE 'America/New_York'));
  RETURN hr >= 11 AND hr < 21;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON TABLE public.nanp_area_code_timezones IS
  'Curated starter NANP area-code→IANA tz map for per-recipient TCPA quiet hours. Verify/complete against the official NANPA report before production reliance; unmapped codes fail safe via sms_send_allowed_now().';
