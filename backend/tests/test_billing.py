"""Tests for core/billing.py — plans, trial, Stripe webhook handling.
No network and no real Stripe: events are plain dicts, signatures are computed
locally with a throwaway secret."""
import hashlib
import hmac
import time
from datetime import datetime, timedelta, timezone

import pytest

from core import billing
from core.config import settings
from core.db import _conn, init_db

USER = "user-1"
CUS = "cus_1"
SECRET = "whsec_test"
PRO_PRICE, MAX_PRICE = "price_pro", "price_max"


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "db_path", str(tmp_path / "t.db"))
    monkeypatch.setattr(settings, "billing_enforce", True)
    monkeypatch.setattr(settings, "billing_bypass_emails", "")
    monkeypatch.setattr(settings, "trial_days", 7)
    monkeypatch.setattr(settings, "trial_credit_usd", 3.0)
    monkeypatch.setattr(settings, "stripe_price_pro", PRO_PRICE)
    monkeypatch.setattr(settings, "stripe_price_max", MAX_PRICE)
    # Don't let a developer's real .env (payment links etc.) leak into the tests.
    monkeypatch.setattr(settings, "stripe_link_pro", "")
    monkeypatch.setattr(settings, "stripe_link_max", "")
    monkeypatch.setattr(settings, "stripe_webhook_secret", "")
    init_db()


def _expire_trial(user=USER):
    old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    billing._get_or_create(user)
    billing._set(user, trial_started_at=old)


def _checkout(ref=f"{USER}__pro", created=1000, **over):
    obj = {"client_reference_id": ref, "payment_status": "paid", "mode": "subscription",
           "customer": CUS, "subscription": "sub_1"}
    obj.update(over)
    return {"type": "checkout.session.completed", "created": created, "data": {"object": obj}}


def _sub(etype="customer.subscription.updated", price=PRO_PRICE, status="active", created=2000,
         end=None):
    end = end or int(time.time()) + 86400 * 30
    return {"type": etype, "created": created, "data": {"object": {
        "id": "sub_1", "customer": CUS, "status": status, "current_period_end": end,
        "items": {"data": [{"price": {"id": price}}]}}}}


# ── signature ────────────────────────────────────────────────────────────

def _header(payload: bytes, secret=SECRET, ts=None):
    ts = ts or int(time.time())
    sig = hmac.new(secret.encode(), f"{ts}.".encode() + payload, hashlib.sha256).hexdigest()
    return f"t={ts},v1={sig}"


def test_signature_accepts_valid():
    p = b'{"a":1}'
    assert billing.verify_stripe_signature(p, _header(p), SECRET)


def test_signature_rejects_wrong_secret_tampering_and_replay():
    p = b'{"a":1}'
    assert not billing.verify_stripe_signature(p, _header(p, "whsec_other"), SECRET)
    assert not billing.verify_stripe_signature(b'{"a":2}', _header(p), SECRET)
    assert not billing.verify_stripe_signature(p, _header(p, ts=int(time.time()) - 3600), SECRET)
    assert not billing.verify_stripe_signature(p, "", SECRET)
    assert not billing.verify_stripe_signature(p, _header(p), "")


# ── entitlement ──────────────────────────────────────────────────────────

def test_new_user_gets_trial_pro():
    ent = billing.get_entitlement(USER)
    assert (ent["plan"], ent["source"]) == ("pro", "trial")


def test_expired_trial_falls_to_free():
    _expire_trial()
    ent = billing.get_entitlement(USER)
    assert (ent["plan"], ent["source"]) == ("free", "free")


def test_paid_subscription_beats_expired_trial():
    _expire_trial()
    billing.handle_stripe_event(_checkout())
    billing.handle_stripe_event(_sub())
    assert billing.get_entitlement(USER)["source"] == "subscription"


def test_lapsed_period_revokes_even_if_cancel_webhook_missed():
    _expire_trial()
    billing.handle_stripe_event(_checkout())
    old = int(time.time()) - 86400 * 10
    billing.handle_stripe_event(_sub(end=old, created=3000))
    assert billing.get_entitlement(USER)["plan"] == "free"


def test_recently_ended_period_within_grace_keeps_access():
    _expire_trial()
    billing.handle_stripe_event(_checkout())
    billing.handle_stripe_event(_sub(end=int(time.time()) - 86400, created=3000))
    assert billing.get_entitlement(USER)["plan"] == "pro"


def test_clamp_mode_downgrades_on_free_and_allows_on_pro():
    _expire_trial()
    mode, notice = billing.clamp_mode(USER, "deep")
    assert mode == "lite" and notice
    billing.handle_stripe_event(_checkout())
    billing.handle_stripe_event(_sub())
    assert billing.clamp_mode(USER, "deep") == ("deep", None)


def test_clamp_is_noop_when_not_enforced(monkeypatch):
    monkeypatch.setattr(settings, "billing_enforce", False)
    _expire_trial()
    assert billing.clamp_mode(USER, "deep") == ("deep", None)


# ── webhook handling ─────────────────────────────────────────────────────

def test_buyer_cannot_pick_plan_by_editing_the_link():
    """Editing client_reference_id to '__max' must not earn Max: the plan comes
    from the price in the subscription event."""
    _expire_trial()
    billing.handle_stripe_event(_checkout(ref=f"{USER}__max"))
    assert billing.get_entitlement(USER)["plan"] == "pro"           # provisional, not max
    billing.handle_stripe_event(_sub(price=PRO_PRICE))              # what they actually bought
    assert billing.get_entitlement(USER)["plan"] == "pro"


def test_max_price_grants_max():
    _expire_trial()
    billing.handle_stripe_event(_checkout(ref=f"{USER}__max"))
    billing.handle_stripe_event(_sub(price=MAX_PRICE))
    assert billing.get_entitlement(USER)["plan"] == "max"


def test_unrelated_product_does_not_keep_paid_access():
    _expire_trial()
    billing.handle_stripe_event(_checkout())
    billing.handle_stripe_event(_sub(price="price_some_other_product"))
    assert billing.get_entitlement(USER)["plan"] == "free"


def test_one_time_payment_is_not_a_subscription():
    _expire_trial()
    assert billing.handle_stripe_event(_checkout(mode="payment")) == "ignored"
    assert billing.get_entitlement(USER)["plan"] == "free"


def test_unpaid_checkout_ignored():
    _expire_trial()
    assert billing.handle_stripe_event(_checkout(payment_status="unpaid")) == "ignored"


def test_cancellation_downgrades():
    _expire_trial()
    billing.handle_stripe_event(_checkout())
    billing.handle_stripe_event(_sub(created=2000))
    billing.handle_stripe_event(_sub("customer.subscription.deleted", status="canceled", created=3000))
    assert billing.get_entitlement(USER)["plan"] == "free"


def test_out_of_order_old_event_cannot_resurrect_a_canceled_plan():
    _expire_trial()
    billing.handle_stripe_event(_checkout(created=1000))
    billing.handle_stripe_event(_sub("customer.subscription.deleted", status="canceled", created=3000))
    out = billing.handle_stripe_event(_sub(status="active", created=2000))     # late, older
    assert out == "stale"
    assert billing.get_entitlement(USER)["plan"] == "free"


def test_redelivered_event_is_harmless():
    _expire_trial()
    billing.handle_stripe_event(_checkout())
    billing.handle_stripe_event(_sub())
    billing.handle_stripe_event(_sub())          # Stripe retry of the same event
    assert billing.get_entitlement(USER)["plan"] == "pro"


def test_subscription_event_before_checkout_is_unmapped_then_resolves():
    _expire_trial()
    assert billing.handle_stripe_event(_sub()) == "unmapped"    # webhook returns 409 -> Stripe retries
    billing.handle_stripe_event(_checkout())
    billing.handle_stripe_event(_sub())
    assert billing.get_entitlement(USER)["plan"] == "pro"


def test_stale_checkout_still_links_customer():
    _expire_trial()
    billing._get_or_create(USER)
    billing._set(USER, last_event_at=5000)
    assert billing.handle_stripe_event(_checkout(created=1000)) == "stale"
    assert billing._user_for_customer(CUS) == USER


def test_malformed_reference_ignored():
    assert billing.handle_stripe_event(_checkout(ref="garbage")) == "ignored"
    assert billing.handle_stripe_event(_checkout(ref="u__enterprise")) == "ignored"


def test_unknown_event_type_ignored():
    assert billing.handle_stripe_event({"type": "invoice.paid", "data": {"object": {}}}) == "ignored"


def test_legacy_mode_without_price_ids_still_works(monkeypatch):
    monkeypatch.setattr(settings, "stripe_price_pro", "")
    monkeypatch.setattr(settings, "stripe_price_max", "")
    _expire_trial()
    billing.handle_stripe_event(_checkout(ref=f"{USER}__max"))
    assert billing.get_entitlement(USER)["plan"] == "max"


def test_admin_grant_not_revoked_by_old_period_end():
    _expire_trial()
    billing._get_or_create(USER)
    billing._set(USER, plan="pro", status="canceled",
                 current_period_end=(datetime.now(timezone.utc) - timedelta(days=90)).isoformat())
    billing._set(USER, plan="pro", status="active", current_period_end=None)   # what the admin grant does
    assert billing.get_entitlement(USER)["plan"] == "pro"


# ── checkout link ────────────────────────────────────────────────────────

def test_checkout_url_tags_user_and_plan(monkeypatch):
    monkeypatch.setattr(settings, "stripe_link_pro", "https://buy.stripe.com/abc")
    url = billing.checkout_url("u9", "a@b.com", "pro")
    assert "client_reference_id=u9__pro" in url and url.startswith("https://buy.stripe.com/abc?")
    assert billing.checkout_url("u9", None, "max") is None       # link not configured


# ── one trial per real email address ─────────────────────────────────────

def _signup(user_id, email):
    from core.known_users import remember_user
    remember_user(user_id, email)
    return billing.get_entitlement(user_id)


@pytest.mark.parametrize("raw,canon", [
    ("Jane.Doe@Gmail.com", "janedoe@gmail.com"),
    ("jane.doe+promo@gmail.com", "janedoe@gmail.com"),
    ("janedoe@googlemail.com", "janedoe@gmail.com"),
    ("jane.doe+x@uni.edu", "jane.doe@uni.edu"),     # dots matter outside Gmail
    ("  JANE@Uni.edu ", "jane@uni.edu"),
])
def test_canonical_email_collapses_aliases(raw, canon):
    assert billing.canonical_email(raw) == canon


@pytest.mark.parametrize("bad", [None, "", "no-at-sign", "a@@b.com", "@x.com", "+tag@x.com"])
def test_canonical_email_rejects_unusable(bad):
    assert billing.canonical_email(bad) is None


def test_first_signup_gets_a_trial():
    ent = _signup("u-a", "jane.doe@gmail.com")
    assert (ent["plan"], ent["source"]) == ("pro", "trial")
    assert ent["trial"]["blocked"] is False


def test_alias_of_a_used_email_gets_no_trial():
    _signup("u-a", "jane.doe@gmail.com")
    for i, alias in enumerate(["janedoe@gmail.com", "jane.doe+2@gmail.com",
                               "j.a.n.e.d.o.e@googlemail.com", "JANEDOE@GMAIL.COM"]):
        ent = _signup(f"u-alias{i}", alias)
        assert ent["plan"] == "free", alias
        assert ent["trial"]["blocked"] is True


def test_different_people_each_get_a_trial():
    _signup("u-a", "jane@gmail.com")
    assert _signup("u-b", "john@gmail.com")["source"] == "trial"
    assert _signup("u-c", "jane@uni.edu")["source"] == "trial"


def test_disposable_email_gets_no_trial():
    ent = _signup("u-d", "x@mailinator.com")
    assert ent["plan"] == "free" and ent["trial"]["blocked"] is True
    assert _signup("u-e", "x@sub.yopmail.com")["plan"] == "free"        # subdomain too


def test_missing_email_fails_open():
    ent = billing.get_entitlement("u-noemail")        # never seen by known_users
    assert ent["source"] == "trial"


def test_blocked_user_gets_clear_notice_and_lite():
    _signup("u-a", "jane@gmail.com")
    _signup("u-b", "jane+2@gmail.com")
    mode, notice = billing.clamp_mode("u-b", "deep")
    assert mode == "lite" and "already been used" in notice


def test_blocked_account_can_still_pay():
    _signup("u-a", "jane@gmail.com")
    _signup("u-b", "jane+2@gmail.com")
    billing.handle_stripe_event(_checkout(ref="u-b__pro"))
    billing.handle_stripe_event(_sub())
    assert billing.get_entitlement("u-b")["source"] == "subscription"


def test_existing_users_are_backfilled_so_new_aliases_are_caught():
    from core.known_users import remember_user
    remember_user("u-old", "old.user@gmail.com")
    billing._get_or_create("u-old")
    with _conn() as conn:                                  # simulate a pre-feature row
        conn.execute("UPDATE subscriptions SET email_canon = NULL WHERE user_id = 'u-old'")
    billing._backfill_email_canon()
    assert _signup("u-new", "olduser+x@gmail.com")["trial"]["blocked"] is True


def test_admin_reset_gives_a_blocked_user_a_fresh_trial():
    _signup("u-a", "jane@gmail.com")
    _signup("u-b", "jane+2@gmail.com")
    billing._set("u-b", trial_started_at=datetime.now(timezone.utc).isoformat(), trial_blocked=0)
    ent = billing.get_entitlement("u-b")
    assert ent["source"] == "trial" and ent["trial"]["blocked"] is False
