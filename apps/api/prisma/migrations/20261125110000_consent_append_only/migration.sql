-- Consent history is the legal record of who agreed to marketing and when (CLB-11, decision 95): rows are only
-- ever added. UPDATE and DELETE are refused unless the transaction sets the erase flag with
-- `SELECT set_config('hg.consent_erase', 'on', true)` (transaction-local, i.e. SET LOCAL).
-- The flag has exactly two users: test cleanup (`deleteMarketingContacts`) and, in Phase 9e, the one documented
-- SQL function that erases an account on request.
-- TRUNCATE is not covered (row triggers do not fire for it); tests and the dev seed rely on `TRUNCATE ... CASCADE`.
-- Phase 9b: the app must connect with a DB role that does not own these tables, so it cannot drop the trigger.
CREATE FUNCTION marketing_consent_events_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('hg.consent_erase', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'marketing_consent_events is append-only' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER marketing_consent_events_no_change
  BEFORE UPDATE OR DELETE ON marketing_consent_events
  FOR EACH ROW EXECUTE FUNCTION marketing_consent_events_append_only();
