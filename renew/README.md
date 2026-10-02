# renew — 계속 새로 쓰는 장치

새 기록을 넣고 한 번 돌리면 소개 사이트의 **숫자 칸**과 **능력별 문단 후보**를 다시 만듭니다.
AI를 부르지 않고, 현재 시각이나 난수도 쓰지 않으므로 **같은 입력이면 항상 같은 결과**가 나옵니다.
필요한 것: Python 3.8 이상 (추가 설치 없음)

## 돌리는 방법 (세 단계)

1. **새 기록 넣기** — `input/` 폴더에 세 파일을 최신으로 바꿔 넣습니다.
   - `ritual-history-YYYY-MM-DD.json` : ALEPH 과제 화면 「내 리추얼 기록 · JSON으로 담기」로 받은 파일 (이름이 가장 뒤인 파일 하나를 씁니다)
   - `attendance.csv` : ALEPH 「내 출석 기록」 표 (`date,symbol,status,in,out`)
   - `tasks.csv` : ALEPH 「내 제출 현황」 (`task,title,submitted,status`)
   - (선택) `mask.txt` : 후보에서 뺄 이름·별명·낱말, 한 줄에 하나
2. **돌리기** — 이 폴더에서 `python3 renew.py` (Windows는 `python renew.py`)
   → `out/numbers.json`, `out/candidates.md`, `out/candidates.json`, `out/site.json` 이 생기고, 마지막 줄에 결과 지문이 찍힙니다.
3. **고르고 올리기** — `out/candidates.md` 를 읽고 사이트에 올릴 문장의 id 를 `approved.txt` 에 적은 뒤
   `python3 renew.py --publish` → `../data/site.json` 이 바뀌고, 사이트(`index.html`)가 이 파일을 그대로 보여 줍니다.
   GitHub에 올리면 끝입니다.

## 같은 입력이면 같은 결과인지 확인하기

두 번 돌려서 마지막 줄의 **결과 지문**이 같으면 됩니다. 새 폴더에서 해 보려면:

```
cp -r renew /tmp/renew-test && cd /tmp/renew-test && python3 renew.py && python3 renew.py
```

## 무엇을 세는가

| 칸 | 계산 | 출처 |
|---|---|---|
| 출석 | 확정된 수업일 중 `출석` 수 / 결석 / 지각 (오늘처럼 `확정 전` 인 날은 뺌) | 내 출석 기록 |
| 리추얼 | 아침·마무리를 둘 다 남긴 날, 강점 행동 실천/일부/못 했다 수 | 리추얼 기록 |
| 넘어진 다음 날 | "못 했다" 다음 기록일에 "실천했다(일부 포함)"를 누른 횟수 | 리추얼 기록 |
| 과제 | 최종 확인 완료 과제 수, 제출 횟수, 다시 낸 과제 | 내 제출 현황 |

**문단 후보**는 내가 쓴 칸(강점이 드러난 일화 등)과 '동료가 말해 준 내 장점' 칸에서만 고릅니다.
세 능력(자기조절력·대인관계력·자기동기력)마다 정해 둔 낱말이 많이 나온 문장 셋을 날짜·칸 이름과 함께 뽑고,
`(이름 가림)` 이 들어 있거나 `mask.txt` 낱말이 들어 있는 문장은 처음부터 뺍니다. 사이트에는 내가 `approved.txt` 에 적은 것만 올라갑니다.

> 공개 저장소에는 리추얼 원문(`input/ritual-history-*.json`)을 올리지 않습니다(.gitignore). 제출용 ZIP에는 동료 이름을 가린 원문이 들어 있어 그대로 돌려 볼 수 있습니다.
