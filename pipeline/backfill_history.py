#!/usr/bin/env python3
"""Normalize local historical football files for BetLedger training.

This adapter is deliberately offline: it never downloads data and never writes
to Supabase. It accepts local Football-Data.co.uk CSV files and OpenFootball
JSON files, validates completed 90-minute scores, resolves canonical team and
competition identifiers, and emits the fixture contract consumed by
``train_model.py --input-json``.

Provider files often use different club names. For any dataset that will be
combined with production UUIDs, pass an explicit JSON team map. Unmapped names
receive deterministic ``hist-team-*`` identifiers and are reported in output
metadata so they cannot be mistaken for production mappings.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
import tempfile
import unicodedata
from dataclasses import asdict, dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from zoneinfo import ZoneInfo


OUTPUT_SCHEMA_VERSION = "betledger-history-backfill/v1"

DEFAULT_DIVISIONS: dict[str, str] = {
    "E0": "PL",
    "SP1": "PD",
    "D1": "BL1",
}

COMPETITION_HINTS: tuple[tuple[str, str], ...] = (
    ("conference league", "UECL"),
    ("europa league", "UEL"),
    ("champions league", "UCL"),
    ("premier league", "PL"),
    ("la liga", "PD"),
    ("bundesliga", "BL1"),
)

DATE_FORMATS: tuple[str, ...] = (
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%d/%m/%Y",
    "%d/%m/%y",
    "%d-%m-%Y",
    "%d-%m-%y",
)


class BackfillError(ValueError):
    """Raised when a source cannot be converted without ambiguity."""


@dataclass(frozen=True)
class CanonicalFixture:
    id: str
    competition_id: str
    competition_code: str
    season: str
    kickoff_at: str
    result_available_at: str
    home_team_id: str
    provenance: str
    away_team_id: str
    home_score: int
    away_score: int

    def to_training_mapping(self) -> dict[str, Any]:
        value = asdict(self)
        # ``provenance`` is internal and used only while constructing the
        # fixture. Keeping provider names out of the training file reduces the
        # chance of redistributing licensed source content.
        value.pop("provenance")
        return value


@dataclass(frozen=True)
class SourceRecord:
    source_kind: str
    source_file: str
    source_row: str
    competition_hint: str | None
    season_hint: str | None
    kickoff_at: datetime
    home_name: str
    away_name: str
    home_score: int
    away_score: int


@dataclass(frozen=True)
class Rejection:
    source_file: str
    source_row: str
    reason: str


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def normalize_key(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value)
    ascii_value = "".join(character for character in decomposed if not unicodedata.combining(character))
    ascii_value = ascii_value.casefold().replace("&", " and ")
    return " ".join(re.findall(r"[a-z0-9]+", ascii_value))


def stable_slug(value: str) -> str:
    key = normalize_key(value)
    slug = "-".join(key.split())[:48].strip("-") or "unknown"
    suffix = sha256_bytes(key.encode("utf-8"))[:10]
    return f"{slug}-{suffix}"


def normalize_season(value: str) -> str:
    raw = value.strip()
    match = re.search(r"(?P<start>20\d{2})\s*[-_/]\s*(?P<end>20\d{2}|\d{2})", raw)
    if match:
        start = int(match.group("start"))
        end_text = match.group("end")
        end = int(end_text) if len(end_text) == 4 else 2000 + int(end_text)
        if end != start + 1:
            raise BackfillError(f"invalid season span {raw!r}")
        return f"{start:04d}-{end % 100:02d}"
    if re.fullmatch(r"20\d{2}", raw):
        start = int(raw)
        return f"{start:04d}-{(start + 1) % 100:02d}"
    raise BackfillError(f"could not infer a season from {raw!r}")


def infer_season(path: Path, *hints: str | None) -> str | None:
    for hint in (*hints, path.stem, path.parent.name):
        if not hint:
            continue
        try:
            return normalize_season(hint)
        except BackfillError:
            continue
    return None


def parse_date(value: str) -> date:
    candidate = value.strip()
    for pattern in DATE_FORMATS:
        try:
            return datetime.strptime(candidate, pattern).date()
        except ValueError:
            continue
    raise BackfillError(f"unsupported date {candidate!r}")


def parse_time(value: str | None) -> time:
    candidate = (value or "").strip()
    if not candidate:
        return time(hour=12)
    for pattern in ("%H:%M", "%H.%M", "%H:%M:%S"):
        try:
            return datetime.strptime(candidate, pattern).time()
        except ValueError:
            continue
    raise BackfillError(f"unsupported kickoff time {candidate!r}")


def parse_kickoff(date_value: str, time_value: str | None, source_zone: ZoneInfo) -> datetime:
    local = datetime.combine(parse_date(date_value), parse_time(time_value), source_zone)
    return local.astimezone(timezone.utc)


def parse_score(value: Any, field: str) -> int:
    if value is None or isinstance(value, bool):
        raise BackfillError(f"missing {field}")
    text = str(value).strip()
    if not re.fullmatch(r"\d+", text):
        raise BackfillError(f"invalid {field} {text!r}")
    score = int(text)
    if score > 30:
        raise BackfillError(f"implausible {field} {score}")
    return score


def clean_team_name(value: Any, field: str) -> str:
    if isinstance(value, Mapping):
        value = value.get("name") or value.get("title") or value.get("code") or value.get("id")
    name = " ".join(str(value or "").split())
    if not name:
        raise BackfillError(f"missing {field}")
    if len(name) > 160:
        raise BackfillError(f"{field} is too long")
    return name


def detect_format(path: Path) -> str:
    suffix = path.suffix.casefold()
    if suffix == ".csv":
        return "football-data"
    if suffix == ".json":
        return "openfootball"
    raise BackfillError(f"cannot infer source format for {path.name!r}")


def football_data_records(
    path: Path, source_zone: ZoneInfo
) -> tuple[list[SourceRecord], list[Rejection]]:
    records: list[SourceRecord] = []
    rejected: list[Rejection] = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        required = {"Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG"}
        missing = required - set(reader.fieldnames or ())
        if missing:
            raise BackfillError(
                f"{path.name}: missing Football-Data columns {sorted(missing)}"
            )
        for index, row in enumerate(reader, start=2):
            try:
                # Ignore unfinished rows, but record why they were omitted.
                home_score = parse_score(row.get("FTHG"), "FTHG")
                away_score = parse_score(row.get("FTAG"), "FTAG")
                records.append(
                    SourceRecord(
                        source_kind="football-data",
                        source_file=path.name,
                        source_row=str(index),
                        competition_hint=(row.get("Div") or "").strip() or None,
                        season_hint=(row.get("Season") or "").strip() or None,
                        kickoff_at=parse_kickoff(
                            str(row.get("Date") or ""), row.get("Time"), source_zone
                        ),
                        home_name=clean_team_name(row.get("HomeTeam"), "HomeTeam"),
                        away_name=clean_team_name(row.get("AwayTeam"), "AwayTeam"),
                        home_score=home_score,
                        away_score=away_score,
                    )
                )
            except BackfillError as exc:
                rejected.append(Rejection(path.name, str(index), str(exc)))
    return records, rejected


def _openfootball_matches(payload: Any) -> tuple[list[Any], str | None, str | None]:
    if isinstance(payload, list):
        return payload, None, None
    if not isinstance(payload, Mapping):
        raise BackfillError("OpenFootball JSON must be an object or match list")
    matches = payload.get("matches") or payload.get("games") or payload.get("rounds")
    if isinstance(matches, list) and matches and isinstance(matches[0], Mapping) and "matches" in matches[0]:
        matches = [match for round_value in matches for match in (round_value.get("matches") or [])]
    if not isinstance(matches, list):
        raise BackfillError("OpenFootball JSON does not contain a matches list")
    name = str(payload.get("name") or payload.get("title") or "") or None
    season = str(payload.get("season") or "") or name
    return matches, name, season


def _score_pair(match: Mapping[str, Any]) -> tuple[int, int]:
    score = match.get("score")
    pair: Any = None
    if isinstance(score, Mapping):
        # Prefer the 90-minute/full-time pair. Penalty fields are deliberately
        # excluded because BetLedger models the result after regulation time.
        for key in ("ft", "full_time", "fulltime", "regular", "regular_time"):
            candidate = score.get(key)
            if isinstance(candidate, (list, tuple)) and len(candidate) >= 2:
                pair = candidate
                break
        if pair is None and "home" in score and "away" in score:
            pair = [score.get("home"), score.get("away")]
    elif isinstance(score, (list, tuple)) and len(score) >= 2:
        pair = score
    if pair is None:
        for home_key, away_key in (
            ("score1", "score2"),
            ("home_score", "away_score"),
            ("homeGoals", "awayGoals"),
        ):
            if home_key in match or away_key in match:
                pair = [match.get(home_key), match.get(away_key)]
                break
    if pair is None:
        raise BackfillError("missing 90-minute score")
    return parse_score(pair[0], "home score"), parse_score(pair[1], "away score")


def openfootball_records(
    path: Path, source_zone: ZoneInfo
) -> tuple[list[SourceRecord], list[Rejection]]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    matches, competition_hint, season_hint = _openfootball_matches(payload)
    records: list[SourceRecord] = []
    rejected: list[Rejection] = []
    for index, raw in enumerate(matches, start=1):
        try:
            if not isinstance(raw, Mapping):
                raise BackfillError("match is not an object")
            date_value = raw.get("date") or raw.get("match_date") or raw.get("kickoff")
            if isinstance(date_value, str) and "T" in date_value:
                parsed = datetime.fromisoformat(date_value.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=source_zone)
                kickoff = parsed.astimezone(timezone.utc)
            else:
                kickoff = parse_kickoff(
                    str(date_value or ""),
                    str(raw.get("time") or raw.get("kickoff_time") or ""),
                    source_zone,
                )
            home_score, away_score = _score_pair(raw)
            records.append(
                SourceRecord(
                    source_kind="openfootball",
                    source_file=path.name,
                    source_row=str(index),
                    competition_hint=str(
                        raw.get("competition") or raw.get("league") or competition_hint or ""
                    ) or None,
                    season_hint=str(raw.get("season") or season_hint or "") or None,
                    kickoff_at=kickoff,
                    home_name=clean_team_name(
                        raw.get("team1") or raw.get("home") or raw.get("home_team"),
                        "home team",
                    ),
                    away_name=clean_team_name(
                        raw.get("team2") or raw.get("away") or raw.get("away_team"),
                        "away team",
                    ),
                    home_score=home_score,
                    away_score=away_score,
                )
            )
        except (BackfillError, ValueError) as exc:
            rejected.append(Rejection(path.name, str(index), str(exc)))
    return records, rejected


def load_json_object(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise BackfillError(f"{path.name} must contain a JSON object")
    return {str(key): value for key, value in payload.items()}


def normalized_lookup(raw: Mapping[str, Any]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key, value in raw.items():
        normalized = normalize_key(key)
        if normalized in output and output[normalized] != value:
            raise BackfillError(f"mapping contains conflicting aliases for {key!r}")
        output[normalized] = value
    return output


def resolve_team(name: str, team_map: Mapping[str, Any]) -> tuple[str, bool]:
    mapped = team_map.get(normalize_key(name))
    if isinstance(mapped, Mapping):
        mapped = mapped.get("id")
    if mapped is not None:
        identifier = str(mapped).strip()
        if not identifier:
            raise BackfillError(f"empty team mapping for {name!r}")
        return identifier, True
    return f"hist-team-{stable_slug(name)}", False


def infer_competition_code(value: str | None) -> str | None:
    if not value:
        return None
    raw = value.strip()
    upper = raw.upper()
    if upper in DEFAULT_DIVISIONS:
        return DEFAULT_DIVISIONS[upper]
    if upper in {"PL", "PD", "BL1", "UCL", "UEL", "UECL"}:
        return upper
    key = normalize_key(raw)
    for phrase, code in COMPETITION_HINTS:
        if phrase in key:
            return code
    return None


def resolve_competition(
    hint: str | None,
    override_code: str | None,
    competition_map: Mapping[str, Any],
) -> tuple[str, str]:
    mapped = competition_map.get(normalize_key(hint or "")) if hint else None
    mapped_code: str | None = None
    mapped_id: str | None = None
    if isinstance(mapped, Mapping):
        mapped_code = str(mapped.get("code") or "").strip().upper() or None
        mapped_id = str(mapped.get("id") or "").strip() or None
    elif mapped is not None:
        mapped_code = str(mapped).strip().upper() or None
    code = (override_code or mapped_code or infer_competition_code(hint) or "").upper()
    if code not in {"PL", "PD", "BL1", "UCL", "UEL", "UECL"}:
        raise BackfillError(
            f"unresolved competition {hint!r}; pass --competition-code or a map"
        )
    return code, mapped_id or f"hist-competition-{code.casefold()}"


def build_fixture(
    record: SourceRecord,
    source_path: Path,
    *,
    season_override: str | None,
    competition_code: str | None,
    team_map: Mapping[str, Any],
    competition_map: Mapping[str, Any],
) -> tuple[CanonicalFixture, tuple[str, ...]]:
    season = season_override or infer_season(
        source_path, record.season_hint
    )
    if season is None:
        raise BackfillError(
            f"could not resolve season for {record.source_file}:{record.source_row}"
        )
    code, competition_id = resolve_competition(
        record.competition_hint, competition_code, competition_map
    )
    home_id, home_mapped = resolve_team(record.home_name, team_map)
    away_id, away_mapped = resolve_team(record.away_name, team_map)
    if home_id == away_id:
        raise BackfillError("home and away teams resolve to the same identifier")
    identity = {
        "competition": code,
        "season": season,
        "kickoff_at": record.kickoff_at.isoformat(),
        "home_team_id": home_id,
        "away_team_id": away_id,
    }
    fixture_id = f"hist-{sha256_bytes(canonical_json(identity))[:24]}"
    unmapped = tuple(
        name
        for name, mapped in (
            (record.home_name, home_mapped),
            (record.away_name, away_mapped),
        )
        if not mapped
    )
    fixture = CanonicalFixture(
        id=fixture_id,
        competition_id=competition_id,
        competition_code=code,
        season=season,
        kickoff_at=record.kickoff_at.isoformat().replace("+00:00", "Z"),
        result_available_at=(record.kickoff_at + timedelta(hours=3))
        .isoformat()
        .replace("+00:00", "Z"),
        home_team_id=home_id,
        provenance=f"{record.source_file}:{record.source_row}",
        away_team_id=away_id,
        home_score=record.home_score,
        away_score=record.away_score,
    )
    return fixture, unmapped


def merge_fixtures(fixtures: Iterable[CanonicalFixture]) -> tuple[list[CanonicalFixture], int]:
    by_id: dict[str, CanonicalFixture] = {}
    duplicates = 0
    for fixture in fixtures:
        previous = by_id.get(fixture.id)
        if previous is None:
            by_id[fixture.id] = fixture
            continue
        if previous.to_training_mapping() != fixture.to_training_mapping():
            raise BackfillError(
                "conflicting results for the same fixture identity: "
                f"{previous.provenance} and {fixture.provenance}"
            )
        duplicates += 1
    return sorted(
        by_id.values(), key=lambda item: (item.kickoff_at, item.id)
    ), duplicates


def write_output(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False, prefix=".history-"
    ) as handle:
        handle.write(rendered)
        temporary = Path(handle.name)
    temporary.replace(path)


def convert(
    inputs: Sequence[Path],
    *,
    source_format: str,
    source_timezone: str,
    season: str | None,
    competition_code: str | None,
    team_map_path: Path | None,
    competition_map_path: Path | None,
    strict: bool,
) -> dict[str, Any]:
    try:
        source_zone = ZoneInfo(source_timezone)
    except Exception as exc:
        raise BackfillError(f"unknown IANA timezone {source_timezone!r}") from exc
    season_override = normalize_season(season) if season else None
    team_map = normalized_lookup(load_json_object(team_map_path))
    competition_map = normalized_lookup(load_json_object(competition_map_path))
    converted: list[CanonicalFixture] = []
    rejections: list[Rejection] = []
    source_manifest: list[dict[str, str]] = []
    unmapped_names: set[str] = set()
    for path in inputs:
        if not path.is_file():
            raise BackfillError(f"input does not exist or is not a file: {path}")
        content = path.read_bytes()
        source_manifest.append(
            {
                "file": path.name,
                "sha256": sha256_bytes(content),
                "format": source_format if source_format != "auto" else detect_format(path),
            }
        )
        current_format = source_format if source_format != "auto" else detect_format(path)
        if current_format == "football-data":
            records, current_rejections = football_data_records(path, source_zone)
        elif current_format == "openfootball":
            records, current_rejections = openfootball_records(path, source_zone)
        else:
            raise BackfillError(f"unsupported format {current_format!r}")
        rejections.extend(current_rejections)
        for record in records:
            try:
                fixture, unmapped = build_fixture(
                    record,
                    path,
                    season_override=season_override,
                    competition_code=competition_code,
                    team_map=team_map,
                    competition_map=competition_map,
                )
                converted.append(fixture)
                unmapped_names.update(unmapped)
            except BackfillError as exc:
                rejections.append(
                    Rejection(record.source_file, record.source_row, str(exc))
                )
    fixtures, duplicate_count = merge_fixtures(converted)
    if strict and rejections:
        first = rejections[0]
        raise BackfillError(
            f"strict conversion rejected {len(rejections)} row(s); first: "
            f"{first.source_file}:{first.source_row}: {first.reason}"
        )
    if not fixtures:
        raise BackfillError("conversion produced no completed fixtures")
    fixture_payload = [fixture.to_training_mapping() for fixture in fixtures]
    return {
        "schema_version": OUTPUT_SCHEMA_VERSION,
        "fixtures": fixture_payload,
        "metadata": {
            "source_files": source_manifest,
            "fixture_count": len(fixture_payload),
            "exact_duplicates_removed": duplicate_count,
            "rejected_count": len(rejections),
            "rejections": [asdict(value) for value in rejections[:50]],
            "rejections_truncated": max(0, len(rejections) - 50),
            "unmapped_team_names": sorted(unmapped_names),
            "unmapped_team_count": len(unmapped_names),
            "source_timezone": source_timezone,
            "content_sha256": sha256_bytes(canonical_json(fixture_payload)),
        },
    }


def self_test() -> None:
    with tempfile.TemporaryDirectory(prefix="betledger-history-test-") as directory:
        root = Path(directory)
        csv_path = root / "E0_2023-24.csv"
        csv_path.write_text(
            "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR\n"
            "E0,12/08/2023,15:00,Arsenal,Nottingham Forest,2,1,H\n"
            "E0,13/08/2023,16:30,Chelsea,Liverpool,1,1,D\n"
            "E0,20/08/2023,14:00,Unplayed,Missing,,,\n",
            encoding="utf-8",
        )
        open_path = root / "champions-league-2023-24.json"
        open_path.write_text(
            json.dumps(
                {
                    "name": "Champions League 2023-24",
                    "matches": [
                        {
                            "date": "2023-09-19",
                            "time": "19:00",
                            "team1": "Milan",
                            "team2": "Newcastle United",
                            "score": {"ft": [0, 0]},
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        team_map = root / "teams.json"
        team_map.write_text(
            json.dumps({"AC Milan": "club-milan", "Milan": "club-milan"}),
            encoding="utf-8",
        )
        csv_payload = convert(
            [csv_path],
            source_format="football-data",
            source_timezone="Europe/London",
            season=None,
            competition_code=None,
            team_map_path=None,
            competition_map_path=None,
            strict=False,
        )
        assert len(csv_payload["fixtures"]) == 2
        assert csv_payload["fixtures"][0]["competition_code"] == "PL"
        assert csv_payload["fixtures"][0]["season"] == "2023-24"
        assert csv_payload["metadata"]["rejected_count"] == 1
        open_payload = convert(
            [open_path],
            source_format="openfootball",
            source_timezone="UTC",
            season=None,
            competition_code=None,
            team_map_path=team_map,
            competition_map_path=None,
            strict=True,
        )
        assert len(open_payload["fixtures"]) == 1
        assert open_payload["fixtures"][0]["competition_code"] == "UCL"
        assert open_payload["fixtures"][0]["home_team_id"] == "club-milan"
        first = convert(
            [csv_path],
            source_format="auto",
            source_timezone="UTC",
            season=None,
            competition_code=None,
            team_map_path=None,
            competition_map_path=None,
            strict=False,
        )
        second = convert(
            [csv_path],
            source_format="auto",
            source_timezone="UTC",
            season=None,
            competition_code=None,
            team_map_path=None,
            competition_map_path=None,
            strict=False,
        )
        assert first["metadata"]["content_sha256"] == second["metadata"]["content_sha256"]
    print("Self-test passed: CSV/JSON parsing, rejection, mapping, and deterministic output.")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, action="append", default=[])
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--format",
        choices=("auto", "football-data", "openfootball"),
        default="auto",
        dest="source_format",
    )
    parser.add_argument(
        "--source-timezone",
        default="UTC",
        help="IANA zone used when a provider file has no UTC offset",
    )
    parser.add_argument("--season", help="Override, for example 2023-24")
    parser.add_argument(
        "--competition-code",
        choices=("PL", "PD", "BL1", "UCL", "UEL", "UECL"),
    )
    parser.add_argument("--team-map", type=Path)
    parser.add_argument("--competition-map", type=Path)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Fail the conversion if any source row is rejected",
    )
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.self_test:
        self_test()
        return 0
    if not args.input or args.output is None:
        raise BackfillError("--input and --output are required unless --self-test is used")
    payload = convert(
        args.input,
        source_format=args.source_format,
        source_timezone=args.source_timezone,
        season=args.season,
        competition_code=args.competition_code,
        team_map_path=args.team_map,
        competition_map_path=args.competition_map,
        strict=args.strict,
    )
    write_output(args.output, payload)
    print(
        json.dumps(
            {
                "status": "succeeded",
                "output": str(args.output),
                "fixtures": payload["metadata"]["fixture_count"],
                "rejected": payload["metadata"]["rejected_count"],
                "unmapped_teams": payload["metadata"]["unmapped_team_count"],
                "content_sha256": payload["metadata"]["content_sha256"],
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
