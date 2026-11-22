"""
Plans, the free trial, and Stripe subscription state.

Model
-----
    free   — Lite mode, Quick paper chat. What everyone falls back to.
    pro    — all search modes, Deep paper chat.      ($10/mo)
    max    — same gating as Pro today (extra Max features aren't gated yet).

Every user gets a one-time TRIAL_DAYS-day trial of Pro, capped by a model-cost
budget (TRIAL_CREDIT_USD). The trial ends at whichever comes first: the
deadline or the credits running out — then the account drops to Free (saved
work is untouched). A paid Stripe subscription overrides all of that.

Nothing here restricts anyone unless settings.billing_enforce is on; until then
the status is computed (so the UI can show the trial) but every limit is a
no-op. Emails in BILLING_BYPASS_EMAILS always get full access.

Stripe: we use Payment Links. The checkout URL carries
`client_reference_id=<user_id>__<plan>` so the `checkout.session.completed`
webhook knows exactly who paid for what — no Stripe SDK needed, only the
signature check below.
"""
import hashlib
import hmac
import logging
import math
import time
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlencode, urlsplit, urlunsplit, parse_qsl

from core.config import settings
from core.db import _conn, _PH, _add_column

log = logging.getLogger("sift.billing")

PLANS = {
    "free": {"label": "Free", "modes": ["lite"], "deep_chat": False},
    "pro": {"label": "Pro", "modes": ["lite", "medium", "deep"], "deep_chat": True},
    "max": {"label": "Max", "modes": ["lite", "medium", "deep"], "deep_chat": True},
}
PAID_STATUSES = {"active", "trialing", "past_due"}   # past_due = Stripe is still retrying the card


# ── storage ────────────────────────────────────────────────────────────────

def init_billing_table() -> None:
    with _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS subscriptions (
                user_id                TEXT PRIMARY KEY,
                plan                   TEXT NOT NULL DEFAULT 'free',
                status                 TEXT NOT NULL DEFAULT 'none',
                trial_started_at       TEXT NOT NULL,
                stripe_customer_id     TEXT,
                stripe_subscription_id TEXT,
                current_period_end     TEXT,
                updated_at             TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS ix_subs_customer ON subscriptions(stripe_customer_id)")
        # Stripe's `created` time of the newest event applied to this user. Stripe
        # doesn't guarantee delivery order, so an older event arriving late must
        # not overwrite newer state (e.g. a stale "active" after "canceled").
        _add_column(conn, "subscriptions", "last_event_at", "INTEGER")
        # Trial-abuse guard: the normalised email each trial was granted to, and
        # whether this account was refused a trial (see _get_or_create).
        _add_column(conn, "subscriptions", "email_canon", "TEXT")
        _add_column(conn, "subscriptions", "trial_blocked", "INTEGER DEFAULT 0")
        conn.execute("CREATE INDEX IF NOT EXISTS ix_subs_email_canon ON subscriptions(email_canon)")
    _backfill_email_canon()


# ── one trial per real email address ───────────────────────────────────────

# Throwaway-inbox providers. Not exhaustive — it stops the common ones; extend it
# if you see new ones in the admin user list.
DISPOSABLE_DOMAINS = {
    "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org",
    "sharklasers.com", "grr.la", "10minutemail.com", "10minutemail.net", "temp-mail.org",
    "tempmail.com", "tempmail.net", "temp-mail.io", "throwawaymail.com", "yopmail.com",
    "yopmail.net", "trashmail.com", "trashmail.net", "getnada.com", "nada.email",
    "maildrop.cc", "dispostable.com", "fakeinbox.com", "mailnesia.com", "mintemail.com",
    "moakt.com", "emailondeck.com", "mohmal.com", "burnermail.io", "spamgourmet.com",
    "mytemp.email", "tempail.com", "tempinbox.com", "discard.email", "inboxkitten.com",
}
_GMAIL_DOMAINS = {"gmail.com", "googlemail.com"}


def canonical_email(email: Optional[str]) -> Optional[str]:
    """Collapse the aliases of one inbox to a single key, so j.doe+x@gmail.com,
    jdoe@googlemail.com and J.Doe@gmail.com are all 'jdoe@gmail.com'.
    Gmail ignores dots and treats googlemail.com as gmail.com; most providers
    ignore a '+tag'. Returns None if it isn't a usable address."""
    email = (email or "").strip().lower()
    if email.count("@") != 1:
        return None
    local, domain = email.split("@")
    if not local or not domain:
        return None
    local = local.split("+", 1)[0]
    if domain in _GMAIL_DOMAINS:
        local, domain = local.replace(".", ""), "gmail.com"
    return f"{local}@{domain}" if local else None


def _is_disposable(email: Optional[str]) -> bool:
    domain = (email or "").strip().lower().rpartition("@")[2]
    return bool(domain) and any(domain == d or domain.endswith("." + d) for d in DISPOSABLE_DOMAINS)


def _email_of(user_id: str) -> Optional[str]:
    try:
        with _conn() as conn:
            row = conn.execute(f"SELECT email FROM known_users WHERE user_id = {_PH}", (user_id,)).fetchone()
        return dict(row)["email"] if row else None
    except Exception:  # noqa: BLE001 — never let a lookup failure break sign-in
        return None


def _backfill_email_canon() -> None:
    """Record the normalised email for accounts that existed before this check,
    so a new alias of an existing user is recognised as a repeat."""
    try:
        with _conn() as conn:
            rows = conn.execute(
                "SELECT s.user_id AS user_id, k.email AS email FROM subscriptions s "
                "JOIN known_users k ON k.user_id = s.user_id WHERE s.email_canon IS NULL"
            ).fetchall()
            for r in rows:
                r = dict(r)
                canon = canonical_email(r["email"])
                if canon:
                    conn.execute(
                        f"UPDATE subscriptions SET email_canon = {_PH} WHERE user_id = {_PH}",
                        (canon, r["user_id"]),
                    )
    except Exception:  # noqa: BLE001 — known_users may not exist yet on a first boot
        log.debug("email_canon backfill skipped", exc_info=True)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _get_or_create(user_id: str) -> dict:
    """The user's subscription row; the trial clock starts the first time we
    see them (their first billing check), not at account creation.

    One free trial per real email address: if this account's normalised email
    already belongs to another account that got a trial, or it is a throwaway
    inbox, the account is created with the trial already over (and flagged).
    A missing email fails open — the user simply gets the normal trial."""
    with _conn() as conn:
        row = conn.execute(f"SELECT * FROM subscriptions WHERE user_id = {_PH}", (user_id,)).fetchone()
        if row:
            return dict(row)
        email = _email_of(user_id)
        canon = canonical_email(email)
        blocked = False
        if canon:
            repeat = conn.execute(
                f"SELECT 1 FROM subscriptions WHERE email_canon = {_PH} AND user_id != {_PH} LIMIT 1",
                (canon, user_id),
            ).fetchone()
            blocked = bool(repeat) or _is_disposable(email)
        if blocked:
            log.info("trial refused for user %s (repeat or disposable email)", user_id)
        now_dt = _now()
        now = now_dt.isoformat()
        # A "used" trial starts far enough back to be over (and out of credits window).
        started = (now_dt - timedelta(days=365)).isoformat() if blocked else now
        conn.execute(
            f"INSERT INTO subscriptions (user_id, plan, status, trial_started_at, updated_at, "
            f"email_canon, trial_blocked) VALUES ({_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH}) "
            f"ON CONFLICT(user_id) DO NOTHING",
            (user_id, "free", "none", started, now, canon, 1 if blocked else 0),
        )
        row = conn.execute(f"SELECT * FROM subscriptions WHERE user_id = {_PH}", (user_id,)).fetchone()
    return dict(row)


def _trial_spend(user_id: str, since_iso: str) -> float:
    with _conn() as conn:
        row = conn.execute(
            "SELECT COALESCE(SUM(c.cost_usd),0) AS spent FROM llm_calls c "
            f"JOIN sessions s ON c.session_id = s.id WHERE s.user_id = {_PH} AND c.created_at >= {_PH}",
            (user_id, since_iso),
        ).fetchone()
    return float(dict(row)["spent"] or 0)


def _is_bypass(user_id: str) -> bool:
    emails = {e.strip().lower() for e in settings.billing_bypass_emails.split(",") if e.strip()}
    if not emails:
        return False
    with _conn() as conn:
        row = conn.execute(f"SELECT email FROM known_users WHERE user_id = {_PH}", (user_id,)).fetchone()
    return bool(row and dict(row)["email"].lower() in emails)


# ── entitlement ────────────────────────────────────────────────────────────

# Days of slack after a paid period ends before access lapses, so a delayed
# renewal webhook doesn't cut off a paying customer.
PERIOD_GRACE_DAYS = 3


def _subscription_is_paid(sub: dict, now: datetime) -> bool:
    """A paid plan counts only while Stripe says so AND the paid period hasn't
    lapsed. The second check is a backstop: if a cancellation/expiry webhook is
    lost, access still ends shortly after the period does, instead of never.
    A missing period end (e.g. an admin grant) skips the backstop."""
    if sub["status"] not in PAID_STATUSES or sub["plan"] not in ("pro", "max"):
        return False
    end = sub.get("current_period_end")
    if end:
        try:
            if now - datetime.fromisoformat(end) > timedelta(days=PERIOD_GRACE_DAYS):
                return False
        except ValueError:
            pass
    return True


def get_entitlement(user_id: str) -> dict:
    """What this user can do right now, and why. Pure read except for creating
    the row that starts the trial clock."""
    sub = _get_or_create(user_id)
    now = _now()

    started = datetime.fromisoformat(sub["trial_started_at"])
    ends = started + timedelta(days=settings.trial_days)
    spent = _trial_spend(user_id, sub["trial_started_at"])
    left = max(0.0, settings.trial_credit_usd - spent)
    days_left = math.ceil((ends - now).total_seconds() / 86400) if ends > now else 0   # partial day counts
    if ends <= now:
        trial_state = "expired"
    elif left <= 0:
        trial_state = "credits_used"
    else:
        trial_state = "active"
    trial = {
        "state": trial_state,
        "days": settings.trial_days,
        "days_left": days_left,
        "ends_at": ends.isoformat(),
        "credits_total": settings.trial_credit_usd,
        "credits_used": round(spent, 4),
        "credits_left": round(left, 4),
        # True when this account was refused a trial because its email already
        # had one (or is a throwaway address) — lets the UI explain why.
        "blocked": bool(sub.get("trial_blocked")) and trial_state == "expired",
    }

    if _is_bypass(user_id):
        plan, source = "max", "bypass"
    elif _subscription_is_paid(sub, now):
        plan, source = sub["plan"], "subscription"
    elif trial_state == "active":
        plan, source = "pro", "trial"
    else:
        plan, source = "free", "free"

    return {
        "plan": plan,
        "source": source,                      # bypass | subscription | trial | free
        "subscription_status": sub["status"],
        "current_period_end": sub.get("current_period_end"),
        "trial": trial,
        "limits": PLANS[plan],
        "enforced": bool(settings.billing_enforce),
        "can_manage": bool(sub.get("stripe_customer_id")),
        "checkout_available": {"pro": bool(settings.stripe_link_pro), "max": bool(settings.stripe_link_max)},
        "portal_url": settings.stripe_portal_url or None,
    }


def clamp_mode(user_id: str, mode: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """(mode_to_use, notice). Downgrades a search mode the plan doesn't include
    to Lite and says so. No-op while billing isn't enforced."""
    if not settings.billing_enforce:
        return mode, None
    from core.modes import MODES, DEFAULT_MODE
    key = (mode or DEFAULT_MODE).lower()
    if key not in MODES:
        key = DEFAULT_MODE
    ent = get_entitlement(user_id)
    if key in ent["limits"]["modes"]:
        return mode, None
    return "lite", _upgrade_notice(ent, f"{MODES[key]['label']} mode")


def clamp_chat_mode(user_id: str, chat_mode: Optional[str]) -> Optional[str]:
    if not settings.billing_enforce or chat_mode != "deep":
        return chat_mode
    return "deep" if get_entitlement(user_id)["limits"]["deep_chat"] else "quick"


def _upgrade_notice(ent: dict, what: str) -> str:
    t = ent["trial"]
    if t.get("blocked"):
        why = "a free trial has already been used with this email address"
    elif t["state"] == "credits_used":
        why = "your trial credits are used up"
    elif t["state"] == "expired":
        why = "your free trial has ended"
    else:
        why = "it isn't included in the Free plan"
    return f"{what} isn't available because {why}, so this run used Lite mode. Upgrade to Pro to unlock it."


# ── Stripe ─────────────────────────────────────────────────────────────────

def checkout_url(user_id: str, email: Optional[str], plan: str) -> Optional[str]:
    base = {"pro": settings.stripe_link_pro, "max": settings.stripe_link_max}.get(plan, "")
    if not base:
        return None
    parts = urlsplit(base)
    q = dict(parse_qsl(parts.query))
    q["client_reference_id"] = f"{user_id}__{plan}"
    if email:
        q["prefilled_email"] = email
    return urlunsplit(parts._replace(query=urlencode(q)))


def verify_stripe_signature(payload: bytes, sig_header: str, secret: str, tolerance: int = 300) -> bool:
    """Stripe-Signature: `t=<ts>,v1=<hmac>[,v1=...]`, where hmac is
    HMAC-SHA256(secret, f"{t}.{payload}"). Rejects stale timestamps (replay)."""
    if not (payload is not None and sig_header and secret):
        return False
    try:
        items = [kv.split("=", 1) for kv in sig_header.split(",") if "=" in kv]
        ts = next(v for k, v in items if k == "t")
        sigs = [v for k, v in items if k == "v1"]
        if abs(time.time() - int(ts)) > tolerance:
            return False
        expected = hmac.new(secret.encode(), f"{ts}.".encode() + payload, hashlib.sha256).hexdigest()
        return any(hmac.compare_digest(expected, s) for s in sigs)
    except (StopIteration, ValueError):
        return False


def _set(user_id: str, **fields) -> None:
    fields["updated_at"] = _now().isoformat()
    cols = ", ".join(f"{k} = {_PH}" for k in fields)
    with _conn() as conn:
        conn.execute(f"UPDATE subscriptions SET {cols} WHERE user_id = {_PH}", (*fields.values(), user_id))


def _user_for_customer(customer_id: str) -> Optional[str]:
    if not customer_id:
        return None
    with _conn() as conn:
        row = conn.execute(
            f"SELECT user_id FROM subscriptions WHERE stripe_customer_id = {_PH}", (customer_id,)
        ).fetchone()
    return dict(row)["user_id"] if row else None


def _plan_for_price(price_id: str) -> Optional[str]:
    if price_id and price_id == settings.stripe_price_max:
        return "max"
    if price_id and price_id == settings.stripe_price_pro:
        return "pro"
    return None


def _prices_configured() -> bool:
    return bool(settings.stripe_price_pro or settings.stripe_price_max)


def _is_stale(user_id: str, event_ts: Optional[int]) -> bool:
    """True if a NEWER Stripe event was already applied for this user, so this
    one (delivered late or out of order) must not overwrite current state."""
    if not event_ts:
        return False
    with _conn() as conn:
        row = conn.execute(
            f"SELECT last_event_at FROM subscriptions WHERE user_id = {_PH}", (user_id,)
        ).fetchone()
    last = dict(row).get("last_event_at") if row else None
    return bool(last and int(event_ts) < int(last))


def handle_stripe_event(event: dict) -> str:
    """Apply one verified Stripe event. Returns a short outcome string for logs.
    Unknown event types are ignored (return 'ignored') so Stripe gets a 2xx."""
    etype = event.get("type", "")
    obj = (event.get("data") or {}).get("object") or {}
    ev_ts = event.get("created")

    if etype == "checkout.session.completed":
        ref = obj.get("client_reference_id") or ""
        user_id, _, ref_plan = ref.rpartition("__")
        if not user_id or ref_plan not in ("pro", "max"):
            log.warning("checkout.session.completed with unusable client_reference_id=%r", ref)
            return "ignored"
        if obj.get("mode") not in (None, "subscription"):
            return "ignored"            # a one-time payment is not a subscription
        if obj.get("payment_status") not in ("paid", "no_payment_required"):
            return "ignored"
        _get_or_create(user_id)
        # ALWAYS link the Stripe customer to this user, even if the event is
        # stale — later subscription.* events find the user through this link.
        fields = {"stripe_customer_id": obj.get("customer"),
                  "stripe_subscription_id": obj.get("subscription")}
        if _is_stale(user_id, ev_ts):
            _set(user_id, **fields)
            return "stale"
        if _prices_configured():
            # client_reference_id is part of a PUBLIC link and can be edited by
            # the buyer, so it must not decide the plan. Grant the lowest paid
            # tier now; the subscription.* event that follows carries the price
            # actually bought and sets the real plan (or revokes it).
            plan = "pro"
        else:
            log.warning("STRIPE_PRICE_PRO/MAX not set: trusting the plan in client_reference_id. "
                        "Set them so the plan is taken from the price actually purchased.")
            plan = ref_plan
        if ev_ts:
            fields["last_event_at"] = int(ev_ts)
        _set(user_id, plan=plan, status="active", **fields)
        return f"activated {plan}"

    if etype in ("customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"):
        user_id = _user_for_customer(obj.get("customer"))
        if not user_id:
            # Out-of-order delivery: checkout.session.completed hasn't linked
            # this customer yet. 'unmapped' makes the webhook return an error
            # so Stripe retries later, by which time the link exists.
            return "unmapped"
        if _is_stale(user_id, ev_ts):
            return "stale"
        status = "canceled" if etype.endswith("deleted") else obj.get("status", "active")
        fields = {"status": status, "stripe_subscription_id": obj.get("id")}
        items = ((obj.get("items") or {}).get("data")) or []
        plan = _plan_for_price(((items[0].get("price") or {}).get("id")) if items else "")
        if plan:
            fields["plan"] = plan
        elif _prices_configured() and not etype.endswith("deleted"):
            # A subscription to something that isn't one of our plans must not
            # keep (or earn) paid access.
            fields["plan"] = "free"
        end = obj.get("current_period_end") or (items[0].get("current_period_end") if items else None)
        if end:
            fields["current_period_end"] = datetime.fromtimestamp(int(end), timezone.utc).isoformat()
        if ev_ts:
            fields["last_event_at"] = int(ev_ts)
        _set(user_id, **fields)
        return f"subscription {status}"

    return "ignored"
