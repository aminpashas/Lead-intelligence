#!/usr/bin/env python3
"""One-shot A2P 10DLC resubmit: DELETE the FAILED us_app_to_person, POST a fresh
one with the v2 message_flow (fixes 30882 — quoted checkbox now matches live forms).
All other fields preserved verbatim from the prior submission. Run once when go'd."""
import os, sys, json, urllib.request, urllib.parse, urllib.error

SID_ACCOUNT = os.environ["TWILIO_ACCOUNT_SID"]
SID_TOKEN = os.environ["TWILIO_AUTH_TOKEN"]
MG = "MGf6d04811cd838cad5cbb51b9b3d42c6b"
EXISTING_SID = "QE2c6890da8086d771620e9b13fadeba0b"
BASE = f"https://messaging.twilio.com/v1/Services/{MG}/Compliance/Usa2p"

# v2 message_flow — verbatim from docs/a2p-message-flow-v2.md
MESSAGE_FLOW = (
    "Patients opt in to SMS by submitting the contact / appointment-request form at "
    "https://www.sfdentistry.com/contact/ or https://www.tmjandsleepapneasanfrancisco.com/contact/. "
    "Each form contains a dedicated \"SMS Consent\" checkbox that is unchecked by default, separate from "
    "the \"I accept the Terms and Conditions\" checkbox, and NOT required to submit the form (consent is "
    "optional). The SMS Consent checkbox reads: \"By checking this box, I agree to receive text messages "
    "from Dion Health about appointment scheduling, reminders, and treatment follow-ups at the mobile "
    "number provided. Message frequency varies. Message and data rates may apply. Reply STOP to opt out "
    "or HELP for help.\" (the practice name — Samadian Cosmetic & Advanced Dentistry, or TMJ & Sleep "
    "— appears in parentheses after \"Dion Health\"). The Messaging Terms and Privacy Policy are "
    "linked in the footer of every page on both sites and are available at "
    "https://www.sfdentistry.com/sms-terms/, https://www.sfdentistry.com/privacy-policy/, "
    "https://www.tmjandsleepapneasanfrancisco.com/sms-terms/, and "
    "https://www.tmjandsleepapneasanfrancisco.com/privacy-policy/. The Privacy Policy states that mobile "
    "information and SMS opt-in data are never shared with, sold to, or rented to third parties or "
    "affiliates for marketing or promotional purposes. Consent is captured per individual at form "
    "submission and stored on that patient's record. No opt-in data is purchased, rented, or shared. "
    "Patients may also opt in by replying START or YES, and may opt out anytime by replying STOP."
)

DESCRIPTION = (
    "Dion Health patient communication for its Samadian Cosmetic & Advanced Dentistry and TMJ & Sleep "
    "practices — appointment reminders, consultation scheduling, treatment follow-ups, and care "
    "coordination for dental and medical patients."
)

MESSAGE_SAMPLES = [
    "Hi Sarah! Your consultation at Dion Health is confirmed for Tuesday, May 6th at 10:00 AM at our SF "
    "location (450 Sutter St). We look forward to seeing you! Reply STOP to opt out.",
    "Hi John, just checking in — do you have any questions about the treatment plan we discussed? "
    "Feel free to call us at (415) 639-5875. Reply STOP to opt out.",
]

# multi-value fields go as repeated keys
PAIRS = [
    ("BrandRegistrationSid", "BNcd0b132357f0fee26e1190b6c7b7a350"),
    ("Description", DESCRIPTION),
    ("MessageFlow", MESSAGE_FLOW),
    ("UsAppToPersonUsecase", "MIXED"),
    ("HasEmbeddedLinks", "true"),
    ("HasEmbeddedPhone", "true"),
    ("OptInMessage", "You are now subscribed to messages from Dion Health. You will receive appointment "
        "reminders, scheduling confirmations, and helpful information about your care. Reply STOP at any "
        "time to unsubscribe. Msg & data rates may apply."),
    ("OptOutMessage", "You have successfully been unsubscribed. You will not receive any more messages "
        "from this number. Reply START to resubscribe."),
    ("HelpMessage", "Reply STOP to unsubscribe. Msg&Data Rates May Apply."),
]
for k in ("START", "YES", "SUBSCRIBE"):
    PAIRS.append(("OptInKeywords", k))
for k in ("OPTOUT", "CANCEL", "END", "QUIT", "UNSUBSCRIBE", "REVOKE", "STOP", "STOPALL"):
    PAIRS.append(("OptOutKeywords", k))
for k in ("HELP", "INFO"):
    PAIRS.append(("HelpKeywords", k))
for s in MESSAGE_SAMPLES:
    PAIRS.append(("MessageSamples", s))


def auth_header():
    import base64
    raw = f"{SID_ACCOUNT}:{SID_TOKEN}".encode()
    return "Basic " + base64.b64encode(raw).decode()


def req(method, url, data=None):
    body = urllib.parse.urlencode(data).encode() if data else None
    r = urllib.request.Request(url, data=body, method=method)
    r.add_header("Authorization", auth_header())
    if body:
        r.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


print(f"[1/2] DELETE {EXISTING_SID} ...")
status, body = req("DELETE", f"{BASE}/{EXISTING_SID}")
print(f"      -> HTTP {status}")
if status not in (204, 404):
    print("      DELETE did not return 204/404 — aborting before POST.")
    print(body)
    sys.exit(1)

print("[2/2] POST new us_app_to_person with v2 message_flow ...")
status, body = req("POST", BASE, PAIRS)
print(f"      -> HTTP {status}")
try:
    obj = json.loads(body)
    print("      sid:", obj.get("sid"))
    print("      campaign_status:", obj.get("campaign_status"))
    print("      errors:", obj.get("errors"))
except Exception:
    print(body)
