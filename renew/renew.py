#!/usr/bin/env python3
"""계속 새로 쓰는 장치 (ALEPH 마지막 과제 A)

input/ 폴더의 세 파일(리추얼 기록 JSON, 출석 CSV, 과제 CSV)을 읽어
  out/numbers.json      숫자 칸 (출처 포함)
  out/candidates.json   능력별 문단 후보 (날짜·근거 포함)
  out/candidates.md     사람이 읽고 승인할 후보 목록
  out/site.json         사이트가 읽는 파일 (숫자 + approved.txt 로 승인한 문단만)
을 만듭니다. 같은 입력이면 항상 같은 결과가 나옵니다(현재 시각·난수·AI 호출을 쓰지 않음).

사용: python3 renew.py            (input/ → out/)
      python3 renew.py --publish  (out/site.json 을 ../data/site.json 으로 복사)
"""
import csv, glob, hashlib, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
IN, OUT = os.path.join(HERE, "input"), os.path.join(HERE, "out")

# 세 능력과 그 능력을 가리키는 낱말 (점수 = 낱말이 나온 수)
ABILITIES = {
    "self_control": ("자기조절력", ["호흡", "컨디션", "침착", "참", "다짐", "약속", "일찍", "미리", "계획", "운동", "자전거", "멘탈", "쉬는시간", "쉬는 시간", "정리"]),
    "relationship": ("대인관계력", ["조장", "조원", "팀", "동료", "친해", "먼저", "말을 걸", "분위기", "간식", "커피", "챙", "같이", "함께", "웃"]),
    "self_motivation": ("자기동기력", ["노력", "이해", "공부", "파고", "뚫", "목표", "도전", "재밌", "열정", "집중", "끝까지", "하고싶", "하고 싶", "처음"]),
}
# 후보로 쓸 칸: 내가 쓴 칸 + 동료가 '나에게' 해 준 말만. (동료끼리 나눈 감사는 쓰지 않음)
OWN_FIELDS = ["강점이 드러난 일화", "그 결과·알게 된 점", "편안했던 장면", "강점을 위해 노력하고 생각한 것", "오늘 지킬 강점·가치"]
PEER_FIELD = re.compile(r"^동료 \d+가 말해 준 내 장점$")
PER_ABILITY = 3
MIN_LEN, MAX_LEN = 15, 160


def read_masks():
    p = os.path.join(IN, "mask.txt")
    if not os.path.exists(p):
        return []
    return [w.strip() for w in open(p, encoding="utf-8") if w.strip() and not w.startswith("#")]


def load_ritual():
    files = sorted(glob.glob(os.path.join(IN, "ritual-history*.json")))
    if not files:
        sys.exit("input/ 에 ritual-history*.json 이 없습니다")
    data = json.load(open(files[-1], encoding="utf-8"))
    return os.path.basename(files[-1]), data["days"]


def split(entry):
    k, _, v = entry.partition(":")
    return k.strip(), v.strip()


def ritual_numbers(days):
    opens = [d for d in days if d.get("open")]
    closes = [d for d in days if d.get("close")]
    flag = {}
    for d in closes:
        for e in d["close"]:
            k, v = split(e)
            if k == "강점 행동":
                flag[d["date"]] = v
    did = sum(1 for v in flag.values() if v == "실천했다")
    part = sum(1 for v in flag.values() if v == "일부 실천했다")
    miss = sorted(k for k, v in flag.items() if v == "못 했다")
    order = sorted(flag)
    bounce = []
    for m in miss:
        i = order.index(m)
        nxt = order[i + 1] if i + 1 < len(order) else None
        bounce.append({"fell": m, "next": nxt, "next_flag": flag.get(nxt)})
    recovered = sum(1 for b in bounce if b["next_flag"] in ("실천했다", "일부 실천했다"))
    # 아침·마무리를 둘 다 남긴 날이 끊기지 않고 이어진 가장 긴 수업일 수
    both = [d["date"] for d in days if d.get("open") and d.get("close")]
    return {
        "first": days[0]["date"], "last": days[-1]["date"],
        "open_days": len(opens), "close_days": len(closes), "both_days": len(both),
        "strength_did": did, "strength_partly": part, "strength_missed": len(miss),
        "missed_dates": miss, "bounce_back": bounce, "recovered_next_day": recovered,
    }


def attendance_numbers():
    rows = list(csv.DictReader(open(os.path.join(IN, "attendance.csv"), encoding="utf-8")))
    rows = [r for r in rows if r["status"] != "확정 전"]
    present = sum(1 for r in rows if r["status"] == "출석")
    absent = sum(1 for r in rows if r["status"] == "결석")
    late = sum(1 for r in rows if r["status"] == "지각")
    early = sorted(r["in"] for r in rows if r["in"])
    on_time = sum(1 for r in rows if r["in"] and r["in"] <= "09:00")
    return {
        "first": min(r["date"] for r in rows), "last": max(r["date"] for r in rows),
        "days": len(rows), "present": present, "absent": absent, "late": late,
        "rate": round(present / len(rows) * 100, 1) if rows else 0,
        "in_by_0900": on_time, "earliest_in": early[0] if early else None,
    }


def task_numbers():
    rows = list(csv.DictReader(open(os.path.join(IN, "tasks.csv"), encoding="utf-8")))
    tasks = sorted({r["task"] for r in rows})
    done = sorted({r["task"] for r in rows if r["status"] == "최종 확인 완료"})
    multi = sorted(t for t in tasks if sum(1 for r in rows if r["task"] == t) > 1)
    dates = sorted(r["submitted"][:10] for r in rows)
    return {"submissions": len(rows), "tasks": len(tasks), "approved": len(done),
            "resubmitted": multi, "first": dates[0], "last": dates[-1]}


def candidates(days, masks):
    out = {k: [] for k in ABILITIES}
    for d in days:
        for part in ("open", "close"):
            for e in d.get(part) or []:
                k, v = split(e)
                who = "나" if k in OWN_FIELDS else ("동료" if PEER_FIELD.match(k) else None)
                if not who or not (MIN_LEN <= len(v) <= MAX_LEN):
                    continue
                if "이름 가림" in v or any(m in v for m in masks):
                    continue  # 다른 사람 이름이 섞였던 문장은 후보에서 뺌
                for key, (_, words) in ABILITIES.items():
                    score = sum(v.count(w) for w in words)
                    if score:
                        out[key].append({"date": d["date"], "who": who, "field": k, "text": v, "score": score})
    result = {}
    for key, items in out.items():
        items.sort(key=lambda x: (-x["score"], x["date"], x["field"], x["text"]))
        seen, pick = set(), []
        for it in items:
            if it["text"] in seen or it["date"] in {p["date"] for p in pick}:
                continue  # 같은 문장·같은 날은 한 번만
            seen.add(it["text"]); pick.append(it)
            if len(pick) == PER_ABILITY:
                break
        for i, p in enumerate(sorted(pick, key=lambda x: x["date"]), 1):
            p["id"] = f"{key}-{p['date']}-{i}"
        result[key] = sorted(pick, key=lambda x: x["date"])
    return result


def approved_ids():
    p = os.path.join(HERE, "approved.txt")
    if not os.path.exists(p):
        return []
    return [l.strip() for l in open(p, encoding="utf-8") if l.strip() and not l.startswith("#")]


def dump(name, obj):
    with open(os.path.join(OUT, name), "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")


def main():
    os.makedirs(OUT, exist_ok=True)
    masks = read_masks()
    rfile, days = load_ritual()
    numbers = {
        "ritual": dict(ritual_numbers(days), source=f"ALEPH 리추얼 기록 ({rfile})"),
        "attendance": dict(attendance_numbers(), source="ALEPH 내 출석 기록 (input/attendance.csv)"),
        "tasks": dict(task_numbers(), source="ALEPH 내 제출 현황 (input/tasks.csv)"),
    }
    cands = candidates(days, masks)
    ok = set(approved_ids())
    paragraphs = {}
    for key, items in cands.items():
        paragraphs[key] = {"label": ABILITIES[key][0],
                           "items": [{k: it[k] for k in ("id", "date", "who", "field", "text")} for it in items if it["id"] in ok]}
    as_of = max(numbers["ritual"]["last"], numbers["attendance"]["last"], numbers["tasks"]["last"])
    site = {"as_of": as_of, "numbers": numbers, "paragraphs": paragraphs}
    dump("numbers.json", numbers)
    dump("candidates.json", cands)
    dump("site.json", site)
    lines = [f"# 문단 후보 (기준일 {as_of})", "", "승인할 후보의 id 를 approved.txt 에 한 줄씩 적고 다시 돌리세요.", ""]
    for key, items in cands.items():
        lines += [f"## {ABILITIES[key][0]}", ""]
        for it in items:
            mark = "x" if it["id"] in ok else " "
            lines.append(f"- [{mark}] `{it['id']}` {it['date']} · {it['who']} · {it['field']} — {it['text']}")
        lines.append("")
    with open(os.path.join(OUT, "candidates.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    h = hashlib.sha256()
    for n in sorted(os.listdir(OUT)):
        h.update(n.encode()); h.update(open(os.path.join(OUT, n), "rb").read())
    print(f"기준일 {as_of} · 승인된 문단 {sum(len(p['items']) for p in paragraphs.values())}개 · 결과 지문 {h.hexdigest()[:16]}")
    if "--publish" in sys.argv:
        dst = os.path.join(HERE, "..", "data", "site.json")
        open(dst, "wb").write(open(os.path.join(OUT, "site.json"), "rb").read())
        print("data/site.json 을 새로 썼습니다")


if __name__ == "__main__":
    main()
