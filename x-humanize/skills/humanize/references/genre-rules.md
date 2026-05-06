# Genre-Aware Allowance Rules

A bigger pattern catalog (KO-1~KO-40, EN-1~EN-22) raises false-positive risk. Some patterns that read as AI tells in one genre are natural in another — `~할 때입니다` closing is AI-flavored in a README but conventional in a 격려사 (encouragement speech). This file defines per-genre exceptions so the rewrite does not strip features the genre actually uses.

## When to consult

After Step 2 detection, before Step 3 rewrite. For every finding:

1. Look up the pattern in the matrix below.
2. If the cell is **block** → fix as the catalog prescribes.
3. If **allow once** → keep one instance, fix the rest.
4. If **allow** → drop the finding (do not flag, do not rewrite).
5. If **warn** → fix unless explicitly demonstrated in the user's voice sample.

If a pattern is not in the matrix, default to the catalog severity (block High/Medium, warn Low).

## Genre detection (first 200 chars)

| Genre | Signals |
|-------|---------|
| **column / essay** (칼럼·에세이) | 1인칭 ("나는", "내가") + 종결 "~다" 우세 + 개인 일화 또는 의견 진술 |
| **report / doc** (리포트·문서) | 헤딩 ≥ 1 + 표/통계/인용 + "~한다" 종결 + 출처 표기 |
| **blog post** (블로그) | "~요" 또는 "~습니다" 친근체 + 질문형 ("~까요?") + 일상 어휘 |
| **formal / official** (공적·공식 문서) | "~합니다/~십시오" 격식체 + "귀하/여러분/임직원 여러분" + 관용 인사말 |
| **marketing copy** (마케팅·카피) | 짧은 문장 (평균 < 25자) + 행동 유도 ("지금", "오늘", "한 번에") + 강조 어휘 |
| **README / technical** | 코드 블록 + 명령어 + "Usage" / "Install" 등 영문 헤딩 + 단계별 절차 |

If signals conflict, ask the user (`AskUserQuestion`) or default to the closest match. README와 technical doc은 report 룰을 적용하되 특수 예외(아래)를 추가로 본다.

## Per-pattern allowance matrix (Korean)

핵심 패턴만 명시. 누락된 패턴은 catalog 기본 severity 적용.

| Pattern | Column | Report | Blog | Formal | Marketing | README |
|---------|--------|--------|------|--------|-----------|--------|
| KO-3 ~적/~성/~화 | warn | **allow** | warn | **allow** | block | warn |
| KO-5 균일 문장 길이 | block | warn | warn | warn | **allow** | warn |
| KO-6 3개 나열 | block | **allow once** | warn | warn | **allow** | **allow once** |
| KO-7 접속사 남용 | block | warn | warn | warn | block | warn |
| KO-10 격식체 과잉 | block | warn | block | **allow** | block | warn |
| KO-11 형식적 결론 | block | warn | warn | **allow once** | block | block |
| KO-13 안내문 종결 | block | block | warn | **allow once** | warn | block |
| KO-15 Bold/이탤릭 | block | **allow** | block | block | **allow** | **allow** |
| KO-16 이모지 불릿 | block | block | **allow once** | block | **allow** | warn |
| KO-19 과잉 균형감 | block | warn | warn | warn | block | warn |
| KO-26 권고형 결말 5+ | warn | block | warn | **allow** | warn | warn |
| KO-28 먼저·반면·결국 3단 | block | **allow once** | warn | warn | block | **allow once** |
| KO-29 1) 2) 3) 인덱싱 | block | **allow** | warn | warn | block | **allow** |
| KO-30 콜론 부제 헤딩 | block | **allow once** | warn | warn | warn | **allow** |
| KO-31 단문 일변도 | block | warn | warn | warn | **allow** | warn |
| KO-35 의인화 추상 주어 | **allow once** | block | warn | block | **allow** | block |
| KO-36 ~할 때입니다 | block | block | warn | **allow once** | warn | block |
| KO-37 X에서 Y로 변환 | warn | **allow once** | warn | warn | **allow** | block |
| KO-39 따옴표 강조 5+ | warn | warn | warn | block | **allow** | warn |

### Threshold adjustments

When the cell is `warn` for count-based patterns, raise the trigger threshold by genre:

| Pattern | Default threshold | Adjustment |
|---------|-------------------|------------|
| KO-7 접속사 남용 | "한 단락 시작 접속사 4+" | Report/README: 5+, Formal: 5+ |
| KO-26 권고형 결말 | "한 문서 5+" | Formal: 8+, Report: 6+ |
| KO-39 따옴표 강조 | "한 문서 5+" | Marketing: 8+, Blog: 7+ |
| KO-3 ~적/~성/~화 | "한 문장 3+" | Report/Formal: 4+ |

## Per-pattern allowance matrix (English)

| Pattern | Column | Report | Blog | Formal | Marketing | README |
|---------|--------|--------|------|--------|-----------|--------|
| EN-7 AI vocabulary (pivotal, underscores) | block | warn | block | warn | block | block |
| EN-9 "Not just X, it's Y" | block | block | warn | block | **allow once** | block |
| EN-10 Rule of three | block | **allow once** | warn | warn | **allow** | **allow once** |
| EN-14 Em-dash overuse | block | warn | warn | block | warn | warn |
| EN-15 Bold/italic emphasis | block | **allow** | warn | block | **allow** | **allow** |
| EN-18 Emoji bullets | block | block | **allow once** | block | **allow** | warn |

## Genre-specific notes

### Column / essay
- 의인화(KO-35) 1회는 수사적 장치로 허용. 2회+이면 차단.
- 단문(KO-31) 1~2 연속은 의도된 호흡으로 허용. 5+ 연속은 여전히 차단.
- 1인칭 어조 보존이 최우선 — "personality" pass는 강하게 적용.

### Report / doc
- 구조 패턴(KO-29, KO-30) 1회는 정보 정리에 유용. 반복은 차단.
- KO-3 (~적/~성/~화)는 학술·정책 어휘로 자연스러움. 한 문장 4개 이상에서만 트리거.
- 권고형 결말(KO-26)은 "권고 사항" 섹션에서는 정상이지만 본문에서 5+이면 차단.

### Blog post
- 친근체와 격식체가 섞이는 게 자연스럽지만, 한 단락 안에서 "~요"와 "~다"가 혼합되면 차단.
- 이모지 1회 정도는 허용 (소제목 또는 강조). 불릿마다 박혀 있으면 차단.

### Formal / official
- 격식체(KO-10) 자체는 장르 본질이므로 허용. 단 "~하시기 바랍니다"가 한 단락에 3+이면 과잉.
- 권고형 결말(KO-26) 임계 5 → 8로 상향. 정책 문서는 권고가 핵심.
- 의인화(KO-35) 절대 차단 — 공적 문서에 어울리지 않음.

### Marketing copy
- 단문(KO-31), 강조 어휘, 이모지가 본질이므로 대부분 허용.
- 단, hype 어휘(KO-1의 "혁신적·획기적·전례 없는") 한 카피에 3+이면 차단 — 마케팅에서도 과잉.

### README / technical
- 영문 헤딩, 코드 블록, 명령어는 절대 건드리지 않음 (Do-NOT list).
- KO-29 (1) 2) 3))과 KO-30 (콜론 헤딩 "Install: Setup")은 기술 문서 관습이므로 허용.
- 1인칭/감정 표현은 Step 4 voice 패스에서 추가하지 않음 — 기술 문서는 중립 톤.

## Output handling

장르 필터로 인해 finding이 dropped 되면 audit 결과 표에 표시:

```
| KO-26 | 권고형 결말 (5회) | High | "...해야 한다" | dropped (genre: formal) |
```

이렇게 하면 사용자가 "왜 안 고쳤지?"를 추적할 수 있다. Dropped finding은 변경률 계산에서 제외 (수정하지 않은 텍스트는 변경 0).

## Voice sample override

사용자가 voice sample을 제공한 경우:
- Sample이 특정 패턴을 명시적으로 사용하면 → 해당 패턴은 그 작성자의 voice로 간주 → allow.
- 단 KO-21(이중 피동)·KO-24(정도부사 중독) 등 명백한 비문/AI 잔재는 voice override로도 허용하지 않음.
- 우선순위: voice sample > genre rules > catalog default.
