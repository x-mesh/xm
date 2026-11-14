"""Sample rule metadata for the humanize ui `ko-area-input` case. Not a real app."""

RULES = [
    ("login-new-country", "새 국가에서 로그인", "이 계정이 처음 쓰는 국가입니다."),
    ("key-old", "오래된 키", "1년 넘게 바꾸지 않은 키입니다. 오래된 키는 여러 곳에 복사돼 있을 수 있습니다."),
]

PARAMS = [
    ("notify_max_age_hours", "알림 대상 나이", "시간", "마지막 발생이 이 시간 안인 알림만 메신저 로 보냅니다."),
]


def message(count: int) -> str:
    return f"새 알림 {count}건"
