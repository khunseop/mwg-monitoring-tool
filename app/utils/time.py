from datetime import datetime, timezone, timedelta

try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None  # type: ignore


# Exported timezone object for Asia/Seoul (KST, UTC+9)
KST_TZ = None
try:
    if ZoneInfo is not None:
        KST_TZ = ZoneInfo("Asia/Seoul")
except Exception:
    KST_TZ = None

if KST_TZ is None:
    # Fallback to fixed UTC+9 offset if IANA tz data is unavailable
    KST_TZ = timezone(timedelta(hours=9))


def now_kst() -> datetime:
    """Return current datetime in Asia/Seoul timezone (timezone-aware)."""
    try:
        if ZoneInfo is not None:
            return datetime.now(ZoneInfo("Asia/Seoul"))
    except Exception:
        pass
    return datetime.now(timezone(timedelta(hours=9)))

