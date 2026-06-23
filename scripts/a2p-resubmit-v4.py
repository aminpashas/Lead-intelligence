#!/usr/bin/env python3
"""A2P 10DLC resubmit v4 — DELETE the FAILED us_app_to_person, POST a fresh one whose
message_flow describes the REAL landing-page opt-in funnel on the branded, owner-controlled
domain dionhealthsf.com (replaces the prior practice-site flow + *.vercel.app URLs that kept
hitting 30882). Branded domain attached to the dion-growth-studio Vercel project 2026-06-23;
all /lp/ pages verified live (200) with the privacy no-sharing clause present.
Mechanism: us_app_to_person has no update endpoint, so resubmit = DELETE sid (204) then POST."""
import os, sys, json, urllib.request, urllib.parse, urllib.error

SID_ACCOUNT = os.environ["TWILIO_ACCOUNT_SID"]
SID_TOKEN = os.environ["TWILIO_AUTH_TOKEN"]
MG = "MGf6d04811cd838cad5cbb51b9b3d42c6b"
EXISTING_SID = "QE2c6890da8086d771620e9b13fadeba0b"
BASE = f"https://messaging.twilio.com/v1/Services/{MG}/Compliance/Usa2p"

# v4 message_flow — landing-page opt-in on the branded domain dionhealthsf.com.
MESSAGE_FLOW = (
    "End users opt in by submitting a contact / consultation-request form on Dion Health's landing pages, "
    "e.g. https://dionhealthsf.com/lp/single-tooth-implant.html and "
    "https://dionhealthsf.com/lp/all-on-4-full-arch.html. Each form collects name, mobile phone number, "
    "and email. Directly above the submit button the page displays this consent disclosure: \"By providing "
    "your phone and email and clicking the button, you give Dion Health your prior express written consent "
    "to be contacted at that number and email — including by automated dialing technology, AI, "
    "prerecorded/artificial voice, and SMS text — about your consultation and treatment options. Consent is "
    "not a condition of purchase. Message frequency varies; message and data rates may apply. Reply STOP to "
    "opt out, HELP for help.\" The landing pages link to the Privacy Policy "
    "(https://dionhealthsf.com/lp/privacy.html) and the Terms (https://dionhealthsf.com/lp/terms.html). "
    "The Privacy Policy states: \"No mobile information, text-messaging opt-in, or consent will be shared, "
    "sold, or rented to third parties or affiliates for their own marketing or promotional purposes.\" "
    "Consent is captured per individual at form submission and stored on that patient's record; no opt-in "
    "data is purchased, rented, or shared. Patients may also opt in by replying START or YES, and may opt "
    "out at any time by replying STOP."
)

DESCRIPTION = (
    "Dion Health sends appointment scheduling, consultation confirmations, lead follow-up, and replies to "
    "prospective and existing dental patients who submitted an inquiry on our website and gave prior express "
    "written consent. Content includes scheduling, consultation reminders, financing information, and "
    "answers to patient questions."
)

# Concrete sample messages — brand name + STOP in each; no embedded links, no phone numbers.
MESSAGE_SAMPLES = [
    "Hi Sarah, it's Dion Health — thanks for your inquiry about dental implants! When's a good time for a "
    "quick call to set up your complimentary consultation? Reply STOP to opt out, HELP for help.",
    "Hi John, Dion Health following up on your consultation request. We have openings this week — would "
    "mornings or afternoons work better? Msg & data rates may apply. Reply STOP to opt out.",
]

PAIRS = [
    ("BrandRegistrationSid", "BNcd0b132357f0fee26e1190b6c7b7a350"),
    ("Description", DESCRIPTION),
    ("MessageFlow", MESSAGE_FLOW),
    ("UsAppToPersonUsecase", "MIXED"),
    ("HasEmbeddedLinks", "false"),
    ("HasEmbeddedPhone", "true"),
    ("OptInMessage", "You are now subscribed to messages from Dion Health. You will receive appointment "
        "reminders, scheduling confirmations, and helpful information about your care. Reply STOP at any "
        "time to unsubscribe. Msg & data rates may apply."),
    ("OptOutMessage", "You're unsubscribed from Dion Health messages and won't receive any more. "
        "Reply HELP for help."),
    ("HelpMessage", "Dion Health: for help call 415-570-2841. Msg & data rates may apply. "
        "Reply STOP to opt out."),
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

print("[2/2] POST new us_app_to_person with v4 message_flow ...")
status, body = req("POST", BASE, PAIRS)
print(f"      -> HTTP {status}")
try:
    obj = json.loads(body)
    print("      sid:", obj.get("sid"))
    print("      campaign_status:", obj.get("campaign_status"))
    print("      errors:", obj.get("errors"))
except Exception:
    print(body)
