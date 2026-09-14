#!/usr/bin/env python3
"""Train and evaluate BetLedger's result-only football models.

The pipeline intentionally starts as a shadow workflow. It reads immutable,
finished fixtures from Supabase, performs season-by-season walk-forward
evaluation, writes a versioned JSON artifact, persists the challenger as
``shadow`` and only asks the database to promote it after every configured
gate passes. The promotion RPC is responsible for re-validating the metrics
and changing champion state atomically.

Secrets are read from environment variables and are never printed. For local
development, ``--input-json`` and ``--dry-run`` exercise the complete modelling
path without requiring Supabase credentials or mutating remote state.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from itertools import groupby
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
from scipy.optimize import minimize
from scipy.special import gammaln

try:
    from .gradient_boosting import (
        FEATURE_SCHEMA_VERSION as GRADIENT_FEATURE_SCHEMA_VERSION,
        fit_gradient_boosting,
        predict_proba as predict_gradient_boosting,
        pre_match_dataset as gradient_boosting_dataset,
        serialize_model as serialize_gradient_boosting,
    )
except ImportError:  # Direct execution: ``python pipeline/train_model.py``.
    from gradient_boosting import (
        FEATURE_SCHEMA_VERSION as GRADIENT_FEATURE_SCHEMA_VERSION,
        fit_gradient_boosting,
        predict_proba as predict_gradient_boosting,
        pre_match_dataset as gradient_boosting_dataset,
        serialize_model as serialize_gradient_boosting,
    )


ARTIFACT_SCHEMA_VERSION = "betledger-model-artifact/v1"
FEATURE_SCHEMA_VERSION = "football-result-only-v1"
INFERENCE_CONTRACT_VERSION = "football-probability-v1"
DEFAULT_MAX_GOALS = 10
EPSILON = 1e-12


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def safe_error(exc: BaseException) -> str:
    """Return a bounded error string without environment-secret values."""

    message = f"{type(exc).__name__}: {exc}"
    for name in (
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_ACCESS_TOKEN",
        "API_FOOTBALL_KEY",
        "FOOTBALL_DATA_API_KEY",
        "BETLEDGER_AUTOMATION_SECRET",
    ):
        secret = os.environ.get(name)
        if secret:
            message = message.replace(secret, "[REDACTED]")
    return message[:1200]


@dataclass(frozen=True)
class Fixture:
    id: str
    competition_id: str
    competition_code: str
    season: str
    kickoff_at: datetime
    home_team_id: str
    away_team_id: str
    home_score: int
    away_score: int
    result_available_at: datetime | None = None
    updated_at: str = ""

    @classmethod
    def from_mapping(
        cls, value: Mapping[str, Any], competitions: Mapping[str, str] | None = None
    ) -> "Fixture":
        competition_id = str(value.get("competition_id", ""))
        competition_code = str(
            value.get("competition_code")
            or (competitions or {}).get(competition_id)
            or competition_id
        )
        kickoff_at = parse_timestamp(str(value["kickoff_at"]))
        raw_result_available_at = str(value.get("result_available_at") or "")
        result_available_at = (
            parse_timestamp(raw_result_available_at)
            if raw_result_available_at
            else kickoff_at + timedelta(hours=3)
        )
        if result_available_at < kickoff_at:
            result_available_at = kickoff_at + timedelta(hours=3)
        return cls(
            id=str(value["id"]),
            competition_id=competition_id,
            competition_code=competition_code,
            season=str(value["season"]),
            kickoff_at=kickoff_at,
            home_team_id=str(value["home_team_id"]),
            away_team_id=str(value["away_team_id"]),
            home_score=int(value["home_score"]),
            away_score=int(value["away_score"]),
            result_available_at=result_available_at,
            updated_at=str(value.get("updated_at") or ""),
        )


@dataclass
class BaselineParameters:
    league_home_goals: float
    league_away_goals: float
    home_attack: dict[str, float]
    home_defence: dict[str, float]
    away_attack: dict[str, float]
    away_defence: dict[str, float]
    smoothing_matches: float
    time_decay_half_life_days: float


@dataclass
class DixonColesEloParameters:
    intercept: float
    home_advantage: float
    elo_coefficient: float
    rho: float
    attack: dict[str, float]
    defence_weakness: dict[str, float]
    elo_ratings: dict[str, float]
    elo_k: float
    elo_home_advantage: float
    time_decay_half_life_days: float
    optimizer_success: bool
    optimizer_message: str


@dataclass(frozen=True)
class EvaluationRow:
    fixture_id: str
    competition_code: str
    season: str
    horizon: str
    actual: int
    baseline: tuple[float, float, float]
    challenger: tuple[float, float, float]
    gradient_boosting: tuple[float, float, float] | None = None


class SupabaseRest:
    """Small PostgREST client that keeps privileged credentials out of output."""

    def __init__(self, base_url: str, service_role_key: str) -> None:
        if not base_url.startswith("https://"):
            raise ValueError("SUPABASE_URL must use HTTPS")
        self.base_url = base_url.rstrip("/")
        self._key = service_role_key

    def request(
        self,
        method: str,
        resource: str,
        *,
        query: Sequence[tuple[str, str]] = (),
        body: Any | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Any:
        url = f"{self.base_url}/rest/v1/{resource.lstrip('/')}"
        if query:
            url += "?" + urllib.parse.urlencode(list(query), safe="(),.*:")
        headers = {
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if extra_headers:
            headers.update(extra_headers)
        data = canonical_json(body) if body is not None else None
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                payload = response.read()
        except urllib.error.HTTPError as exc:
            response_body = exc.read().decode("utf-8", errors="replace")[:800]
            raise RuntimeError(
                f"Supabase REST {method} {resource} failed with HTTP "
                f"{exc.code}: {response_body}"
            ) from exc
        if not payload:
            return None
        return json.loads(payload.decode("utf-8"))

    def paginated(self, resource: str, query: Sequence[tuple[str, str]]) -> list[Any]:
        rows: list[Any] = []
        page_size = 1000
        offset = 0
        while True:
            page = self.request(
                "GET",
                resource,
                query=query,
                extra_headers={"Range": f"{offset}-{offset + page_size - 1}"},
            )
            if not isinstance(page, list):
                raise RuntimeError(f"Unexpected response while reading {resource}")
            rows.extend(page)
            if len(page) < page_size:
                return rows
            offset += page_size


def poisson_pmf(k: int, rate: float) -> float:
    return math.exp(-rate + k * math.log(max(rate, EPSILON)) - math.lgamma(k + 1))


def score_matrix(
    home_rate: float,
    away_rate: float,
    *,
    rho: float = 0.0,
    max_goals: int = DEFAULT_MAX_GOALS,
) -> np.ndarray:
    home = np.array([poisson_pmf(i, home_rate) for i in range(max_goals + 1)])
    away = np.array([poisson_pmf(i, away_rate) for i in range(max_goals + 1)])
    matrix = np.outer(home, away)
    if rho:
        corrections = {
            (0, 0): 1.0 - home_rate * away_rate * rho,
            (0, 1): 1.0 + home_rate * rho,
            (1, 0): 1.0 + away_rate * rho,
            (1, 1): 1.0 - rho,
        }
        for (home_goals, away_goals), correction in corrections.items():
            matrix[home_goals, away_goals] *= max(correction, EPSILON)
    total = float(matrix.sum())
    if not math.isfinite(total) or total <= 0:
        raise ValueError("Invalid score distribution")
    return matrix / total


def one_x_two(matrix: np.ndarray) -> tuple[float, float, float]:
    home = float(np.tril(matrix, k=-1).sum())
    draw = float(np.trace(matrix))
    away = float(np.triu(matrix, k=1).sum())
    total = home + draw + away
    return (home / total, draw / total, away / total)


def actual_outcome(fixture: Fixture) -> int:
    if fixture.home_score > fixture.away_score:
        return 0
    if fixture.home_score == fixture.away_score:
        return 1
    return 2


def time_weights(fixtures: Sequence[Fixture], half_life_days: float) -> np.ndarray:
    cutoff = max(fixture.kickoff_at for fixture in fixtures)
    ages = np.array(
        [max((cutoff - fixture.kickoff_at).total_seconds() / 86400.0, 0.0) for fixture in fixtures]
    )
    return np.exp(-math.log(2.0) * ages / half_life_days)


def _shrunk_ratio(numerator: float, denominator: float, prior_weight: float) -> float:
    return float((numerator + prior_weight) / (denominator + prior_weight))


def fit_poisson_baseline(
    fixtures: Sequence[Fixture],
    *,
    smoothing_matches: float = 6.0,
    half_life_days: float = 365.0,
) -> BaselineParameters:
    if not fixtures:
        raise ValueError("Cannot fit baseline without fixtures")
    weights = time_weights(fixtures, half_life_days)
    weight_sum = float(weights.sum())
    league_home = max(
        sum(weight * fixture.home_score for weight, fixture in zip(weights, fixtures))
        / weight_sum,
        0.15,
    )
    league_away = max(
        sum(weight * fixture.away_score for weight, fixture in zip(weights, fixtures))
        / weight_sum,
        0.15,
    )
    teams = sorted(
        {fixture.home_team_id for fixture in fixtures}
        | {fixture.away_team_id for fixture in fixtures}
    )
    accum: dict[str, dict[str, float]] = {
        team: {
            "home_w": 0.0,
            "away_w": 0.0,
            "home_for": 0.0,
            "home_against": 0.0,
            "away_for": 0.0,
            "away_against": 0.0,
        }
        for team in teams
    }
    for weight, fixture in zip(weights, fixtures):
        home = accum[fixture.home_team_id]
        away = accum[fixture.away_team_id]
        home["home_w"] += float(weight)
        home["home_for"] += float(weight) * fixture.home_score
        home["home_against"] += float(weight) * fixture.away_score
        away["away_w"] += float(weight)
        away["away_for"] += float(weight) * fixture.away_score
        away["away_against"] += float(weight) * fixture.home_score

    home_attack: dict[str, float] = {}
    home_defence: dict[str, float] = {}
    away_attack: dict[str, float] = {}
    away_defence: dict[str, float] = {}
    for team, values in accum.items():
        home_attack[team] = _shrunk_ratio(
            values["home_for"] / league_home,
            values["home_w"],
            smoothing_matches,
        )
        home_defence[team] = _shrunk_ratio(
            values["home_against"] / league_away,
            values["home_w"],
            smoothing_matches,
        )
        away_attack[team] = _shrunk_ratio(
            values["away_for"] / league_away,
            values["away_w"],
            smoothing_matches,
        )
        away_defence[team] = _shrunk_ratio(
            values["away_against"] / league_home,
            values["away_w"],
            smoothing_matches,
        )
    return BaselineParameters(
        league_home_goals=league_home,
        league_away_goals=league_away,
        home_attack=home_attack,
        home_defence=home_defence,
        away_attack=away_attack,
        away_defence=away_defence,
        smoothing_matches=smoothing_matches,
        time_decay_half_life_days=half_life_days,
    )


def predict_poisson(
    parameters: BaselineParameters, home_team: str, away_team: str
) -> tuple[float, float, float]:
    home_rate = parameters.league_home_goals * parameters.home_attack.get(
        home_team, 1.0
    ) * parameters.away_defence.get(away_team, 1.0)
    away_rate = parameters.league_away_goals * parameters.away_attack.get(
        away_team, 1.0
    ) * parameters.home_defence.get(home_team, 1.0)
    return one_x_two(score_matrix(
        float(np.clip(home_rate, 0.15, 5.0)),
        float(np.clip(away_rate, 0.15, 5.0)),
    ))


def _elo_expected(home_rating: float, away_rating: float, home_advantage: float) -> float:
    return 1.0 / (1.0 + 10.0 ** (-((home_rating + home_advantage) - away_rating) / 400.0))


def _elo_actual(fixture: Fixture) -> float:
    if fixture.home_score > fixture.away_score:
        return 1.0
    if fixture.home_score == fixture.away_score:
        return 0.5
    return 0.0


def update_elo(
    ratings: dict[str, float],
    fixture: Fixture,
    *,
    k_factor: float,
    home_advantage: float,
) -> None:
    home = ratings.setdefault(fixture.home_team_id, 1500.0)
    away = ratings.setdefault(fixture.away_team_id, 1500.0)
    expected = _elo_expected(home, away, home_advantage)
    goal_margin = abs(fixture.home_score - fixture.away_score)
    margin_multiplier = 1.0 if goal_margin <= 1 else math.log1p(goal_margin)
    change = k_factor * margin_multiplier * (_elo_actual(fixture) - expected)
    ratings[fixture.home_team_id] = home + change
    ratings[fixture.away_team_id] = away - change


def result_available_at(fixture: Fixture) -> datetime:
    """First conservative instant at which a completed score may affect features."""

    return fixture.result_available_at or fixture.kickoff_at + timedelta(hours=3)


def elo_differences(
    fixtures: Sequence[Fixture], *, k_factor: float, home_advantage: float
) -> tuple[np.ndarray, dict[str, float]]:
    ratings: dict[str, float] = {}
    differences: list[float] = []
    pending_results: list[Fixture] = []

    def release_results(cutoff: datetime) -> None:
        ready = sorted(
            (fixture for fixture in pending_results if result_available_at(fixture) <= cutoff),
            key=lambda item: (result_available_at(item), item.kickoff_at, item.id),
        )
        pending_results[:] = [
            fixture for fixture in pending_results if result_available_at(fixture) > cutoff
        ]
        for fixture in ready:
            update_elo(
                ratings,
                fixture,
                k_factor=k_factor,
                home_advantage=home_advantage,
            )

    ordered = sorted(fixtures, key=lambda item: (item.kickoff_at, item.id))
    for kickoff, kickoff_rows in groupby(ordered, key=lambda item: item.kickoff_at):
        batch = list(kickoff_rows)
        release_results(kickoff)
        for fixture in batch:
            home = ratings.setdefault(fixture.home_team_id, 1500.0)
            away = ratings.setdefault(fixture.away_team_id, 1500.0)
            differences.append((home + home_advantage - away) / 400.0)
        # A result enters state only at its recorded/fallback availability
        # instant, never merely because the next fixture has kicked off.
        pending_results.extend(batch)
    for fixture in sorted(
        pending_results,
        key=lambda item: (result_available_at(item), item.kickoff_at, item.id),
    ):
        update_elo(
            ratings,
            fixture,
            k_factor=k_factor,
            home_advantage=home_advantage,
        )
    return np.asarray(differences, dtype=float), ratings


def fit_dixon_coles_elo(
    fixtures: Sequence[Fixture],
    *,
    half_life_days: float = 365.0,
    elo_k: float = 20.0,
    elo_home_advantage: float = 55.0,
) -> DixonColesEloParameters:
    ordered = sorted(fixtures, key=lambda item: (item.kickoff_at, item.id))
    if not ordered:
        raise ValueError("Cannot fit challenger without fixtures")
    teams = sorted(
        {fixture.home_team_id for fixture in ordered}
        | {fixture.away_team_id for fixture in ordered}
    )
    indices = {team: index for index, team in enumerate(teams)}
    n_teams = len(teams)
    home_indices = np.asarray([indices[f.home_team_id] for f in ordered])
    away_indices = np.asarray([indices[f.away_team_id] for f in ordered])
    home_goals = np.asarray([f.home_score for f in ordered], dtype=float)
    away_goals = np.asarray([f.away_score for f in ordered], dtype=float)
    weights = time_weights(ordered, half_life_days)
    elo_diff, final_ratings = elo_differences(
        ordered, k_factor=elo_k, home_advantage=elo_home_advantage
    )
    baseline = fit_poisson_baseline(ordered, half_life_days=half_life_days)
    base_mean = max(
        math.sqrt(baseline.league_home_goals * baseline.league_away_goals), 0.1
    )
    x0 = np.zeros(4 + 2 * n_teams, dtype=float)
    x0[0] = math.log(base_mean)
    x0[1] = math.log(
        max(baseline.league_home_goals / baseline.league_away_goals, 0.1)
    )

    def objective(raw: np.ndarray) -> float:
        intercept, home_advantage, elo_coefficient, rho = raw[:4]
        attack = raw[4 : 4 + n_teams]
        weakness = raw[4 + n_teams :]
        attack = attack - attack.mean()
        weakness = weakness - weakness.mean()
        home_eta = (
            intercept
            + home_advantage
            + attack[home_indices]
            + weakness[away_indices]
            + elo_coefficient * elo_diff
        )
        away_eta = (
            intercept
            + attack[away_indices]
            + weakness[home_indices]
            - elo_coefficient * elo_diff
        )
        home_rate = np.clip(np.exp(np.clip(home_eta, -3.0, 3.0)), 0.15, 5.0)
        away_rate = np.clip(np.exp(np.clip(away_eta, -3.0, 3.0)), 0.15, 5.0)
        log_likelihood = (
            home_goals * np.log(home_rate)
            - home_rate
            - gammaln(home_goals + 1.0)
            + away_goals * np.log(away_rate)
            - away_rate
            - gammaln(away_goals + 1.0)
        )
        tau = np.ones(len(ordered), dtype=float)
        mask_00 = (home_goals == 0) & (away_goals == 0)
        mask_01 = (home_goals == 0) & (away_goals == 1)
        mask_10 = (home_goals == 1) & (away_goals == 0)
        mask_11 = (home_goals == 1) & (away_goals == 1)
        tau[mask_00] = 1.0 - home_rate[mask_00] * away_rate[mask_00] * rho
        tau[mask_01] = 1.0 + home_rate[mask_01] * rho
        tau[mask_10] = 1.0 + away_rate[mask_10] * rho
        tau[mask_11] = 1.0 - rho
        if np.any(tau <= EPSILON):
            return 1e12
        regularization = 0.035 * (
            float(np.square(attack).sum()) + float(np.square(weakness).sum())
        )
        return float(-(weights * (log_likelihood + np.log(tau))).sum() + regularization)

    bounds = [
        (-2.0, 1.5),
        (-0.8, 0.8),
        (-1.0, 1.0),
        (-0.2, 0.2),
    ] + [(-2.0, 2.0)] * (2 * n_teams)
    result = minimize(
        objective,
        x0,
        method="L-BFGS-B",
        bounds=bounds,
        options={"maxiter": 700, "ftol": 1e-9},
    )
    raw = np.asarray(result.x, dtype=float)
    attack_values = raw[4 : 4 + n_teams]
    weakness_values = raw[4 + n_teams :]
    attack_values -= attack_values.mean()
    weakness_values -= weakness_values.mean()
    return DixonColesEloParameters(
        intercept=float(raw[0]),
        home_advantage=float(raw[1]),
        elo_coefficient=float(raw[2]),
        rho=float(raw[3]),
        attack={team: float(attack_values[index]) for team, index in indices.items()},
        defence_weakness={
            team: float(weakness_values[index]) for team, index in indices.items()
        },
        elo_ratings={team: float(rating) for team, rating in final_ratings.items()},
        elo_k=elo_k,
        elo_home_advantage=elo_home_advantage,
        time_decay_half_life_days=half_life_days,
        optimizer_success=bool(result.success and math.isfinite(float(result.fun))),
        optimizer_message=str(result.message)[:300],
    )


def predict_dixon_coles_elo(
    parameters: DixonColesEloParameters,
    home_team: str,
    away_team: str,
    ratings: Mapping[str, float] | None = None,
) -> tuple[float, float, float]:
    current_ratings = ratings if ratings is not None else parameters.elo_ratings
    home_rating = float(current_ratings.get(home_team, 1500.0))
    away_rating = float(current_ratings.get(away_team, 1500.0))
    elo_diff = (
        home_rating + parameters.elo_home_advantage - away_rating
    ) / 400.0
    home_eta = (
        parameters.intercept
        + parameters.home_advantage
        + parameters.attack.get(home_team, 0.0)
        + parameters.defence_weakness.get(away_team, 0.0)
        + parameters.elo_coefficient * elo_diff
    )
    away_eta = (
        parameters.intercept
        + parameters.attack.get(away_team, 0.0)
        + parameters.defence_weakness.get(home_team, 0.0)
        - parameters.elo_coefficient * elo_diff
    )
    return one_x_two(
        score_matrix(
            float(np.clip(math.exp(float(np.clip(home_eta, -3.0, 3.0))), 0.15, 5.0)),
            float(np.clip(math.exp(float(np.clip(away_eta, -3.0, 3.0))), 0.15, 5.0)),
            rho=parameters.rho,
        )
    )


def season_order(fixtures: Sequence[Fixture]) -> list[str]:
    first_kickoff: dict[str, datetime] = {}
    for fixture in fixtures:
        first_kickoff[fixture.season] = min(
            first_kickoff.get(fixture.season, fixture.kickoff_at), fixture.kickoff_at
        )
    return sorted(first_kickoff, key=lambda season: first_kickoff[season])


def walk_forward(
    fixtures: Sequence[Fixture],
    *,
    min_training_matches: int,
    sealed_season: str | None,
) -> tuple[list[EvaluationRow], list[dict[str, Any]]]:
    rows: list[EvaluationRow] = []
    fold_reports: list[dict[str, Any]] = []
    competition_codes = sorted({fixture.competition_code for fixture in fixtures})
    for competition_code in competition_codes:
        competition_rows = sorted(
            [f for f in fixtures if f.competition_code == competition_code],
            key=lambda item: (item.kickoff_at, item.id),
        )
        seasons = season_order(competition_rows)
        if sealed_season and sealed_season in seasons:
            seasons = seasons[: seasons.index(sealed_season) + 1]
        for test_index in range(1, len(seasons)):
            training_seasons = set(seasons[:test_index])
            test_season = seasons[test_index]
            training = [f for f in competition_rows if f.season in training_seasons]
            testing = [f for f in competition_rows if f.season == test_season]
            if len(training) < min_training_matches or not testing:
                fold_reports.append(
                    {
                        "competition": competition_code,
                        "test_season": test_season,
                        "status": "skipped_insufficient_training_data",
                        "training_matches": len(training),
                        "test_matches": len(testing),
                    }
                )
                continue
            if max(f.kickoff_at for f in training) >= min(f.kickoff_at for f in testing):
                fold_reports.append(
                    {
                        "competition": competition_code,
                        "test_season": test_season,
                        "status": "skipped_overlapping_seasons",
                        "training_matches": len(training),
                        "test_matches": len(testing),
                    }
                )
                continue
            baseline = fit_poisson_baseline(training)
            challenger = fit_dixon_coles_elo(training)
            gradient_status = "evaluated"
            gradient_predictions: list[tuple[float, float, float] | None]
            try:
                gradient_train, gradient_targets, gradient_test, _ = (
                    gradient_boosting_dataset(training, testing)
                )
                gradient_model = fit_gradient_boosting(
                    gradient_train, gradient_targets
                )
                gradient_probabilities = predict_gradient_boosting(
                    gradient_model, gradient_test
                )
                gradient_predictions = [
                    tuple(float(value) for value in probability)
                    for probability in gradient_probabilities
                ]
            except (ValueError, FloatingPointError) as exc:
                # DC+Elo remains the deployable main model. A failed experimental
                # fit is visible in the fold report and can never affect promotion.
                gradient_status = f"skipped:{type(exc).__name__}"
                gradient_predictions = [None] * len(testing)
            live_ratings = dict(challenger.elo_ratings)
            if len(testing) != len(gradient_predictions):
                raise RuntimeError("gradient prediction rows are misaligned")
            paired_testing = list(zip(testing, gradient_predictions))
            pending_results: list[Fixture] = []
            for kickoff, kickoff_rows in groupby(paired_testing, key=lambda item: item[0].kickoff_at):
                batch = list(kickoff_rows)
                ready = sorted(
                    (
                        fixture
                        for fixture in pending_results
                        if result_available_at(fixture) <= kickoff
                    ),
                    key=lambda item: (result_available_at(item), item.kickoff_at, item.id),
                )
                pending_results = [
                    fixture
                    for fixture in pending_results
                    if result_available_at(fixture) > kickoff
                ]
                for fixture in ready:
                    update_elo(
                        live_ratings,
                        fixture,
                        k_factor=challenger.elo_k,
                        home_advantage=challenger.elo_home_advantage,
                    )
                for fixture, gradient_probability in batch:
                    rows.append(
                        EvaluationRow(
                            fixture_id=fixture.id,
                            competition_code=competition_code,
                            season=test_season,
                            horizon="pre_match_result_only",
                            actual=actual_outcome(fixture),
                            baseline=predict_poisson(
                                baseline, fixture.home_team_id, fixture.away_team_id
                            ),
                            challenger=predict_dixon_coles_elo(
                                challenger,
                                fixture.home_team_id,
                                fixture.away_team_id,
                                live_ratings,
                            ),
                            gradient_boosting=gradient_probability,
                        )
                    )
                pending_results.extend(fixture for fixture, _ in batch)
            fold_reports.append(
                {
                    "competition": competition_code,
                    "test_season": test_season,
                    "status": "evaluated",
                    "training_matches": len(training),
                    "test_matches": len(testing),
                    "optimizer_success": challenger.optimizer_success,
                    "gradient_boosting_status": gradient_status,
                }
            )
    return rows, fold_reports


def metrics_for(rows: Sequence[EvaluationRow], field: str) -> dict[str, float | int]:
    if not rows:
        return {"n": 0, "log_loss": float("nan"), "brier": float("nan"), "ece": float("nan")}
    probabilities = np.asarray([getattr(row, field) for row in rows], dtype=float)
    actual = np.asarray([row.actual for row in rows], dtype=int)
    selected = np.clip(probabilities[np.arange(len(rows)), actual], EPSILON, 1.0)
    log_loss = float(-np.log(selected).mean())
    targets = np.eye(3, dtype=float)[actual]
    brier = float(np.square(probabilities - targets).sum(axis=1).mean())
    confidence = probabilities.max(axis=1)
    predicted = probabilities.argmax(axis=1)
    correct = (predicted == actual).astype(float)
    ece = 0.0
    for lower in np.linspace(0.0, 0.9, 10):
        upper = lower + 0.1
        mask = (confidence >= lower) & (
            (confidence < upper) if upper < 1.0 else (confidence <= upper)
        )
        if mask.any():
            ece += float(mask.mean()) * abs(
                float(confidence[mask].mean()) - float(correct[mask].mean())
            )
    return {"n": len(rows), "log_loss": log_loss, "brier": brier, "ece": ece}


def paired_bootstrap_log_loss(
    rows: Sequence[EvaluationRow], *, samples: int, seed: int = 20260909
) -> dict[str, float | int]:
    if not rows:
        return {"samples": samples, "mean_improvement": float("nan"), "ci_low": float("nan"), "ci_high": float("nan")}
    baseline_loss = np.asarray(
        [-math.log(max(row.baseline[row.actual], EPSILON)) for row in rows]
    )
    challenger_loss = np.asarray(
        [-math.log(max(row.challenger[row.actual], EPSILON)) for row in rows]
    )
    paired_improvement = baseline_loss - challenger_loss
    rng = np.random.default_rng(seed)
    bootstrap = np.empty(samples, dtype=float)
    for index in range(samples):
        bootstrap[index] = float(
            paired_improvement[rng.integers(0, len(rows), size=len(rows))].mean()
        )
    return {
        "samples": samples,
        "mean_improvement": float(paired_improvement.mean()),
        "ci_low": float(np.quantile(bootstrap, 0.025)),
        "ci_high": float(np.quantile(bootstrap, 0.975)),
    }


def finite_metric(value: float) -> float | None:
    return float(value) if math.isfinite(value) else None


def evaluate_promotion(
    rows: Sequence[EvaluationRow],
    fold_reports: Sequence[Mapping[str, Any]],
    *,
    sealed_season: str | None,
    min_evaluation_fixtures: int,
    bootstrap_samples: int,
) -> dict[str, Any]:
    sealed_rows = [row for row in rows if sealed_season and row.season == sealed_season]
    baseline = metrics_for(sealed_rows, "baseline")
    challenger = metrics_for(sealed_rows, "challenger")
    gradient_rows = [
        row for row in sealed_rows if row.gradient_boosting is not None
    ]
    gradient = metrics_for(gradient_rows, "gradient_boosting")
    gradient_reference = metrics_for(gradient_rows, "challenger")
    gradient_log_loss = float(gradient["log_loss"])
    gradient_reference_loss = float(gradient_reference["log_loss"])
    gradient_relative_improvement = (
        (gradient_reference_loss - gradient_log_loss) / gradient_reference_loss
        if math.isfinite(gradient_reference_loss) and gradient_reference_loss > 0
        else float("nan")
    )
    gradient_by_competition = {
        competition: metrics_for(
            [row for row in gradient_rows if row.competition_code == competition],
            "gradient_boosting",
        )
        for competition in sorted({row.competition_code for row in gradient_rows})
    }
    bootstrap = paired_bootstrap_log_loss(
        sealed_rows, samples=bootstrap_samples
    )
    baseline_log_loss = float(baseline["log_loss"])
    challenger_log_loss = float(challenger["log_loss"])
    relative_improvement = (
        (baseline_log_loss - challenger_log_loss) / baseline_log_loss
        if math.isfinite(baseline_log_loss) and baseline_log_loss > 0
        else float("nan")
    )

    competition_degradations: dict[str, float | None] = {}
    for competition in sorted({row.competition_code for row in sealed_rows}):
        subset = [row for row in sealed_rows if row.competition_code == competition]
        base_metric = float(metrics_for(subset, "baseline")["log_loss"])
        challenger_metric = float(metrics_for(subset, "challenger")["log_loss"])
        degradation = (
            (challenger_metric - base_metric) / base_metric if base_metric > 0 else float("inf")
        )
        competition_degradations[competition] = finite_metric(degradation)
    finite_degradations = [
        value for value in competition_degradations.values() if value is not None
    ]
    max_competition_degradation = max(finite_degradations, default=float("inf"))
    # This result-only pipeline evaluates one horizon. Keeping this separate in
    # the contract prevents a future contextual horizon from inheriting this gate.
    max_horizon_degradation = (
        (challenger_log_loss - baseline_log_loss) / baseline_log_loss
        if math.isfinite(baseline_log_loss) and baseline_log_loss > 0
        else float("inf")
    )
    sealed_fold_reports = [
        report
        for report in fold_reports
        if sealed_season and report.get("test_season") == sealed_season
    ]
    optimizer_success = all(
        report.get("optimizer_success", True)
        for report in fold_reports
        if report.get("status") == "evaluated"
        and (not sealed_season or report.get("test_season") == sealed_season)
    )
    gates = {
        "sealed_season_present": bool(sealed_season and sealed_rows),
        "all_sealed_competitions_evaluated": bool(
            sealed_fold_reports
            and all(report.get("status") == "evaluated" for report in sealed_fold_reports)
        ),
        "min_evaluation_fixtures": len(sealed_rows) >= min_evaluation_fixtures,
        "relative_log_loss_improvement": bool(
            math.isfinite(relative_improvement) and relative_improvement >= 0.01
        ),
        "bootstrap_ci_favorable": bool(
            math.isfinite(float(bootstrap["ci_low"]))
            and float(bootstrap["ci_low"]) > 0.0
        ),
        "brier_not_worse": bool(
            math.isfinite(float(baseline["brier"]))
            and float(challenger["brier"]) <= float(baseline["brier"]) + 1e-12
        ),
        "calibration_not_worse": bool(
            math.isfinite(float(baseline["ece"]))
            and float(challenger["ece"]) <= float(baseline["ece"]) + 1e-12
        ),
        "per_competition_no_degradation": bool(
            math.isfinite(max_competition_degradation)
            and max_competition_degradation <= 0.02
        ),
        "per_horizon_no_degradation": bool(
            math.isfinite(max_horizon_degradation)
            and max_horizon_degradation <= 0.02
        ),
        "optimizer_success": bool(optimizer_success),
    }
    return {
        "sealed_season": sealed_season,
        "horizon": "pre_match_result_only",
        "evaluated_fixtures": len(sealed_rows),
        "baseline": {key: finite_metric(value) if isinstance(value, float) else value for key, value in baseline.items()},
        "challenger": {key: finite_metric(value) if isinstance(value, float) else value for key, value in challenger.items()},
        "gradient_boosting_shadow": {
            "status": "shadow_only",
            "promotion_blocker": "single_distribution_inference_contract_not_implemented",
            "coverage": len(gradient_rows) / len(sealed_rows) if sealed_rows else 0.0,
            "relative_log_loss_improvement_vs_dixon_coles_elo": finite_metric(
                gradient_relative_improvement
            ),
            "by_competition": {
                competition: {
                    key: finite_metric(value) if isinstance(value, float) else value
                    for key, value in values.items()
                }
                for competition, values in gradient_by_competition.items()
            },
            **{
                key: finite_metric(value) if isinstance(value, float) else value
                for key, value in gradient.items()
            },
        },
        "relative_log_loss_improvement": finite_metric(relative_improvement),
        "bootstrap_log_loss": {
            key: finite_metric(value) if isinstance(value, float) else value
            for key, value in bootstrap.items()
        },
        "bootstrap_log_loss_ci_low": finite_metric(float(bootstrap["ci_low"])),
        "competition_log_loss_degradation": competition_degradations,
        "max_competition_degradation": finite_metric(max_competition_degradation),
        "max_horizon_degradation": finite_metric(max_horizon_degradation),
        "brier_not_worse": gates["brier_not_worse"],
        "calibration_not_worse": gates["calibration_not_worse"],
        "gates": gates,
        "promotion_eligible": all(gates.values()),
        "folds": list(fold_reports),
    }


def group_by_competition(fixtures: Sequence[Fixture]) -> dict[str, list[Fixture]]:
    grouped: dict[str, list[Fixture]] = {}
    for fixture in fixtures:
        grouped.setdefault(fixture.competition_code, []).append(fixture)
    return grouped


def fit_final_models(fixtures: Sequence[Fixture]) -> tuple[dict[str, Any], bool]:
    output: dict[str, Any] = {}
    optimizer_success = True
    for code, rows in sorted(group_by_competition(fixtures).items()):
        ordered = sorted(rows, key=lambda item: (item.kickoff_at, item.id))
        baseline = fit_poisson_baseline(ordered)
        challenger = fit_dixon_coles_elo(ordered)
        optimizer_success = optimizer_success and challenger.optimizer_success
        gradient_payload: dict[str, Any]
        try:
            gradient_features, gradient_targets, _, gradient_states = (
                gradient_boosting_dataset(ordered)
            )
            gradient_model = fit_gradient_boosting(
                gradient_features, gradient_targets
            )
            gradient_payload = {
                "status": "shadow",
                "model": serialize_gradient_boosting(
                    gradient_model, gradient_states
                ),
            }
        except (ValueError, FloatingPointError) as exc:
            gradient_payload = {
                "status": "skipped",
                "reason": type(exc).__name__,
            }
        output[code] = {
            "training_matches": len(ordered),
            "training_from": iso_z(ordered[0].kickoff_at),
            "training_to": iso_z(ordered[-1].kickoff_at),
            "poisson_baseline": asdict(baseline),
            "dixon_coles_elo": asdict(challenger),
            "gradient_boosting": gradient_payload,
        }
    return output, optimizer_success


def build_inference_parameters(models: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """Translate training output into the stable TypeScript inference contract.

    Competition-specific values are authoritative. The top-level weighted values
    are conservative fallbacks for an unmapped competition or newly promoted
    team and keep older inference deployments forward-compatible.
    """

    total_weight = max(
        sum(int(model.get("training_matches", 0)) for model in models.values()), 1
    )
    weighted_rho = 0.0
    weighted_home_advantage = 0.0
    weighted_intercept = 0.0
    weighted_elo_coefficient = 0.0
    weighted_elo_home_advantage = 0.0
    weighted_log_rate_uncertainty = 0.0
    competition_models: dict[str, Any] = {}
    team_accumulators: dict[str, dict[str, Any]] = {}
    for code, model in sorted(models.items()):
        weight = int(model.get("training_matches", 0))
        baseline = dict(model["poisson_baseline"])
        challenger = dict(model["dixon_coles_elo"])
        weighted_rho += weight * float(challenger["rho"])
        weighted_home_advantage += weight * float(challenger["home_advantage"])
        weighted_intercept += weight * float(challenger["intercept"])
        weighted_elo_coefficient += weight * float(challenger["elo_coefficient"])
        weighted_elo_home_advantage += weight * float(challenger["elo_home_advantage"])
        teams = sorted(
            set(baseline["home_attack"])
            | set(baseline["away_attack"])
            | set(challenger["elo_ratings"])
        )
        # Poisson information grows with the number of team-exposures observed.
        # This is deliberately conservative and bounded: it provides a stable
        # predictive-uncertainty contract for the TypeScript QMC mixture, while
        # competition activation still requires the independent shadow gates.
        average_team_matches = max(2.0 * weight / max(len(teams), 1), 1.0)
        log_rate_uncertainty_sd = float(
            np.clip(math.sqrt(1.0 / (1.2 * average_team_matches)), 0.06, 0.30)
        )
        weighted_log_rate_uncertainty += weight * log_rate_uncertainty_sd
        ratings: dict[str, Any] = {}
        for team in teams:
            entry = {
                "elo": float(challenger["elo_ratings"].get(team, 1500.0)),
                "attack": float(challenger["attack"].get(team, 0.0)),
                "defense_weakness": float(
                    challenger["defence_weakness"].get(team, 0.0)
                ),
                "attack_home": float(baseline["home_attack"].get(team, 1.0)),
                "defense_home": float(baseline["home_defence"].get(team, 1.0)),
                "attack_away": float(baseline["away_attack"].get(team, 1.0)),
                "defense_away": float(baseline["away_defence"].get(team, 1.0)),
            }
            ratings[team] = entry
            accumulator = team_accumulators.setdefault(
                team,
                {
                    "weight": 0,
                    "elo": 0.0,
                    "attack": 0.0,
                    "defense_weakness": 0.0,
                    "attack_home": 0.0,
                    "defense_home": 0.0,
                    "attack_away": 0.0,
                    "defense_away": 0.0,
                    "competitions": {},
                },
            )
            accumulator["weight"] += weight
            for field in (
                "elo",
                "attack",
                "defense_weakness",
                "attack_home",
                "defense_home",
                "attack_away",
                "defense_away",
            ):
                accumulator[field] += weight * entry[field]
            accumulator["competitions"][code] = entry
        competition_models[code] = {
            "training_matches": weight,
            "rho": float(challenger["rho"]),
            "intercept_log": float(challenger["intercept"]),
            "home_advantage_log": float(challenger["home_advantage"]),
            "elo_coefficient": float(challenger["elo_coefficient"]),
            "elo_home_advantage": float(challenger["elo_home_advantage"]),
            "league_home_goals": float(baseline["league_home_goals"]),
            "league_away_goals": float(baseline["league_away_goals"]),
            "uncertainty_method": "poisson_exposure_qmc_v1",
            "log_rate_uncertainty_sd": log_rate_uncertainty_sd,
            "team_ratings": ratings,
        }
    team_ratings: dict[str, Any] = {}
    for team, accumulator in sorted(team_accumulators.items()):
        weight = max(int(accumulator.pop("weight")), 1)
        competitions = accumulator.pop("competitions")
        team_ratings[team] = {
            field: float(value) / weight for field, value in accumulator.items()
        }
        team_ratings[team]["competitions"] = competitions
    return {
        "inference_contract_version": INFERENCE_CONTRACT_VERSION,
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "max_goals": DEFAULT_MAX_GOALS,
        "rho": weighted_rho / total_weight,
        "intercept_log": weighted_intercept / total_weight,
        "home_advantage_log": weighted_home_advantage / total_weight,
        "elo_coefficient": weighted_elo_coefficient / total_weight,
        "elo_home_advantage": weighted_elo_home_advantage / total_weight,
        "uncertainty_method": "poisson_exposure_qmc_v1",
        "log_rate_uncertainty_sd": weighted_log_rate_uncertainty / total_weight,
        "team_ratings": team_ratings,
        "competition_models": competition_models,
        "context_enabled": False,
        "context_coefficients": {},
    }


def infer_contract_rates(
    parameters: Mapping[str, Any],
    competition_code: str,
    home_team_id: str,
    away_team_id: str,
) -> tuple[float, float, float]:
    """Reference implementation mirrored by the TypeScript Edge runtime."""
    if parameters.get("inference_contract_version") != INFERENCE_CONTRACT_VERSION:
        raise ValueError("Unsupported inference contract")
    competition_models = parameters.get("competition_models", {})
    competition = competition_models.get(competition_code, {})
    source = competition or parameters
    competition_ratings = source.get("team_ratings") or {}
    global_ratings = parameters.get("team_ratings", {})
    # Newly qualified UEFA clubs retain their domestic/cross-competition
    # rating until enough competition-specific observations exist.
    home = competition_ratings.get(home_team_id) or global_ratings.get(home_team_id, {})
    away = competition_ratings.get(away_team_id) or global_ratings.get(away_team_id, {})
    home_elo = float(home.get("elo", 1500.0))
    away_elo = float(away.get("elo", 1500.0))
    elo_home_advantage = float(
        source.get("elo_home_advantage", parameters.get("elo_home_advantage", 55.0))
    )
    elo_difference = (home_elo + elo_home_advantage - away_elo) / 400.0
    intercept = float(source.get("intercept_log", parameters.get("intercept_log", 0.0)))
    home_advantage = float(
        source.get("home_advantage_log", parameters.get("home_advantage_log", 0.0))
    )
    elo_coefficient = float(
        source.get("elo_coefficient", parameters.get("elo_coefficient", 0.0))
    )
    home_eta = (
        intercept
        + home_advantage
        + float(home.get("attack", 0.0))
        + float(away.get("defense_weakness", 0.0))
        + elo_coefficient * elo_difference
    )
    away_eta = (
        intercept
        + float(away.get("attack", 0.0))
        + float(home.get("defense_weakness", 0.0))
        - elo_coefficient * elo_difference
    )
    home_rate = float(np.clip(math.exp(float(np.clip(home_eta, -3.0, 3.0))), 0.15, 5.0))
    away_rate = float(np.clip(math.exp(float(np.clip(away_eta, -3.0, 3.0))), 0.15, 5.0))
    rho = float(source.get("rho", parameters.get("rho", 0.0)))
    return home_rate, away_rate, max(-0.2, min(0.2, rho))


def dataset_digest(fixtures: Sequence[Fixture]) -> str:
    return sha256_json(
        [
            {
                "id": fixture.id,
                "kickoff_at": iso_z(fixture.kickoff_at),
                "home_score": fixture.home_score,
                "away_score": fixture.away_score,
                "result_available_at": iso_z(result_available_at(fixture)),
                "updated_at": fixture.updated_at,
            }
            for fixture in sorted(fixtures, key=lambda item: item.id)
        ]
    )


def write_artifact(output_dir: Path, artifact: Mapping[str, Any], version: str) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / f"{version}.json"
    payload = json.dumps(artifact, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=output_dir, delete=False, prefix=".artifact-"
    ) as handle:
        handle.write(payload)
        temporary = Path(handle.name)
    temporary.replace(destination)
    return destination


def load_offline(path: Path) -> list[Fixture]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw_fixtures = payload.get("fixtures", payload) if isinstance(payload, dict) else payload
    if not isinstance(raw_fixtures, list):
        raise ValueError("Offline input must be a fixture list or {'fixtures': [...]} object")
    fixtures = [Fixture.from_mapping(row) for row in raw_fixtures]
    return sorted(fixtures, key=lambda item: (item.kickoff_at, item.id))


def resolve_owner(client: SupabaseRest, configured_owner: str | None) -> str:
    if configured_owner:
        return configured_owner
    rows = client.request(
        "GET",
        "app_members",
        query=(("select", "user_id"), ("role", "eq.owner"), ("limit", "2")),
    )
    if not isinstance(rows, list) or len(rows) != 1:
        raise RuntimeError("Expected exactly one configured BetLedger owner")
    return str(rows[0]["user_id"])


def fetch_fixtures(client: SupabaseRest, owner_id: str) -> list[Fixture]:
    competition_rows = client.request(
        "GET",
        "competitions",
        query=(("select", "id,code"), ("owner_id", f"eq.{owner_id}")),
    )
    if not isinstance(competition_rows, list):
        raise RuntimeError("Could not read competitions")
    competition_codes = {str(row["id"]): str(row["code"]) for row in competition_rows}
    raw = client.paginated(
        "fixtures",
        (
            (
                "select",
                "id,competition_id,season,kickoff_at,home_team_id,away_team_id,home_score,away_score,result_available_at,updated_at",
            ),
            ("owner_id", f"eq.{owner_id}"),
            ("status", "eq.finished"),
            ("home_score", "not.is.null"),
            ("away_score", "not.is.null"),
            ("order", "kickoff_at.asc,id.asc"),
        ),
    )
    return [Fixture.from_mapping(row, competition_codes) for row in raw]


def latest_training_run(client: SupabaseRest, owner_id: str) -> Mapping[str, Any] | None:
    rows = client.request(
        "GET",
        "training_runs",
        query=(
            ("select", "id,status,last_result_at,metrics,created_at"),
            ("owner_id", f"eq.{owner_id}"),
            ("status", "in.(succeeded,skipped)"),
            ("order", "created_at.desc"),
            ("limit", "1"),
        ),
    )
    return rows[0] if isinstance(rows, list) and rows else None


def create_training_run(
    client: SupabaseRest,
    owner_id: str,
    trigger_type: str,
    data_cutoff: datetime,
    status: str = "running",
) -> str:
    idempotency_key = os.environ.get("TRAINING_IDEMPOTENCY_KEY") or None
    if idempotency_key:
        existing = client.request(
            "GET",
            "training_runs",
            query=(
                ("select", "id"),
                ("owner_id", f"eq.{owner_id}"),
                ("idempotency_key", f"eq.{idempotency_key}"),
                ("limit", "1"),
            ),
        )
        if isinstance(existing, list) and existing:
            return str(existing[0]["id"])
    rows = client.request(
        "POST",
        "training_runs",
        body={
            "owner_id": owner_id,
            "trigger_type": trigger_type,
            "status": status,
            "data_cutoff": iso_z(data_cutoff),
            "started_at": iso_z(utc_now()),
            "idempotency_key": idempotency_key,
        },
        extra_headers={"Prefer": "return=representation"},
    )
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("Could not create training run")
    return str(rows[0]["id"])


def patch_training_run(client: SupabaseRest, run_id: str, values: Mapping[str, Any]) -> None:
    client.request(
        "PATCH",
        "training_runs",
        query=(("id", f"eq.{run_id}"),),
        body=dict(values),
        extra_headers={"Prefer": "return=minimal"},
    )


def persist_shadow_model(
    client: SupabaseRest,
    owner_id: str,
    version: str,
    cutoff: datetime,
    artifact_hash: str,
    parameters: Mapping[str, Any],
    metrics: Mapping[str, Any],
    *,
    model_family: str = "dixon_coles_elo",
    feature_schema_version: str = FEATURE_SCHEMA_VERSION,
) -> str:
    rows = client.request(
        "POST",
        "model_versions",
        body={
            "owner_id": owner_id,
            "version": version,
            "model_family": model_family,
            "status": "shadow",
            "training_cutoff": iso_z(cutoff),
            "artifact_sha256": artifact_hash,
            "parameters": parameters,
            "metrics": metrics,
            "feature_schema_version": feature_schema_version,
        },
        extra_headers={"Prefer": "return=representation"},
    )
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("Could not persist shadow model")
    return str(rows[0]["id"])


def promote_model(client: SupabaseRest, owner_id: str, model_version_id: str) -> None:
    client.request(
        "POST",
        "rpc/promote_model_version",
        body={"p_owner_id": owner_id, "p_model_version_id": model_version_id},
    )


def generate_synthetic_fixtures() -> list[Fixture]:
    rng = np.random.default_rng(42)
    teams = [f"team-{index}" for index in range(10)]
    attack = np.linspace(-0.35, 0.35, len(teams))
    fixtures: list[Fixture] = []
    fixture_number = 0
    for season_number, season in enumerate(("2023-24", "2024-25", "2025-26")):
        kickoff = datetime(2023 + season_number, 8, 1, tzinfo=timezone.utc)
        for round_number in range(12):
            shuffled = list(np.roll(teams, round_number))
            for match_index in range(0, len(shuffled), 2):
                home = shuffled[match_index]
                away = shuffled[match_index + 1]
                home_index = teams.index(home)
                away_index = teams.index(away)
                home_rate = math.exp(0.25 + attack[home_index] - attack[away_index] * 0.25)
                away_rate = math.exp(0.05 + attack[away_index] - attack[home_index] * 0.25)
                fixture_number += 1
                fixtures.append(
                    Fixture(
                        id=f"synthetic-{fixture_number}",
                        competition_id="synthetic-league",
                        competition_code="TEST",
                        season=season,
                        kickoff_at=kickoff + timedelta(days=round_number * 7, hours=match_index),
                        home_team_id=home,
                        away_team_id=away,
                        home_score=int(rng.poisson(home_rate)),
                        away_score=int(rng.poisson(away_rate)),
                    )
                )
    return sorted(fixtures, key=lambda item: (item.kickoff_at, item.id))


def self_test() -> None:
    fixtures = generate_synthetic_fixtures()
    simultaneous_time = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
    simultaneous = [
        Fixture(
            id="simultaneous-a", competition_id="test", competition_code="TEST",
            season="2025-26", kickoff_at=simultaneous_time,
            home_team_id="shared", away_team_id="x", home_score=5, away_score=0,
        ),
        Fixture(
            id="simultaneous-b", competition_id="test", competition_code="TEST",
            season="2025-26", kickoff_at=simultaneous_time,
            home_team_id="shared", away_team_id="y", home_score=0, away_score=2,
        ),
    ]
    differences, _ = elo_differences(simultaneous, k_factor=20.0, home_advantage=55.0)
    assert np.allclose(differences, np.asarray([55.0 / 400.0, 55.0 / 400.0]))
    delayed = [
        Fixture(
            id="early-result", competition_id="test", competition_code="TEST",
            season="2025-26", kickoff_at=simultaneous_time,
            home_team_id="shared-hour", away_team_id="x-hour", home_score=5, away_score=0,
        ),
        Fixture(
            id="before-result-available", competition_id="test", competition_code="TEST",
            season="2025-26", kickoff_at=simultaneous_time + timedelta(hours=1),
            home_team_id="shared-hour", away_team_id="y-hour", home_score=0, away_score=1,
        ),
    ]
    delayed_differences, _ = elo_differences(delayed, k_factor=20.0, home_advantage=55.0)
    assert np.allclose(delayed_differences, np.asarray([55.0 / 400.0, 55.0 / 400.0]))
    released = [
        delayed[0],
        Fixture(
            id="after-result-available", competition_id="test", competition_code="TEST",
            season="2025-26", kickoff_at=simultaneous_time + timedelta(hours=4),
            home_team_id="shared-hour", away_team_id="z-hour", home_score=0, away_score=1,
        ),
    ]
    released_differences, _ = elo_differences(released, k_factor=20.0, home_advantage=55.0)
    assert released_differences[1] != 55.0 / 400.0
    rows, folds = walk_forward(
        fixtures,
        min_training_matches=50,
        sealed_season="2025-26",
    )
    assert rows, "walk-forward produced no evaluation rows"
    assert all(abs(sum(row.baseline) - 1.0) < 1e-9 for row in rows)
    assert all(abs(sum(row.challenger) - 1.0) < 1e-9 for row in rows)
    gradient_rows = [row for row in rows if row.gradient_boosting is not None]
    assert gradient_rows, "gradient boosting produced no shadow evaluation rows"
    assert all(
        abs(sum(row.gradient_boosting or ())) - 1.0 < 1e-9
        for row in gradient_rows
    )
    report = evaluate_promotion(
        rows,
        folds,
        sealed_season="2025-26",
        min_evaluation_fixtures=40,
        bootstrap_samples=100,
    )
    assert report["evaluated_fixtures"] == 60
    assert report["gradient_boosting_shadow"]["status"] == "shadow_only"
    fitted, _ = fit_final_models(fixtures)
    assert fitted["TEST"]["gradient_boosting"]["status"] == "shadow"
    inference = build_inference_parameters(fitted)
    assert inference["inference_contract_version"] == INFERENCE_CONTRACT_VERSION
    assert inference["team_ratings"]
    assert inference["context_enabled"] is False
    assert inference["uncertainty_method"] == "poisson_exposure_qmc_v1"
    assert 0.06 <= inference["log_rate_uncertainty_sd"] <= 0.30
    assert all(
        model["uncertainty_method"] == "poisson_exposure_qmc_v1"
        and 0.06 <= model["log_rate_uncertainty_sd"] <= 0.30
        for model in inference["competition_models"].values()
    )
    golden_path = Path(__file__).resolve().parents[1] / "tests" / "golden" / "inference_contract_v1.json"
    golden = json.loads(golden_path.read_text(encoding="utf-8"))
    golden_rates = infer_contract_rates(
        golden["parameters"],
        golden["competition_code"],
        golden["home_team_id"],
        golden["away_team_id"],
    )
    assert abs(golden_rates[0] - golden["expected"]["lambda_home"]) < 1e-12
    assert abs(golden_rates[1] - golden["expected"]["lambda_away"]) < 1e-12
    assert abs(golden_rates[2] - golden["expected"]["rho"]) < 1e-12
    global_fallback_rates = infer_contract_rates(
        {
            "inference_contract_version": INFERENCE_CONTRACT_VERSION,
            "intercept_log": 0.0,
            "home_advantage_log": 0.0,
            "elo_coefficient": 1.0,
            "elo_home_advantage": 0.0,
            "rho": -0.04,
            "team_ratings": {
                "promoted-home": {"elo": 1700.0},
                "promoted-away": {"elo": 1300.0},
            },
            "competition_models": {
                "UCL": {
                    "intercept_log": 0.0,
                    "home_advantage_log": 0.0,
                    "elo_coefficient": 1.0,
                    "elo_home_advantage": 0.0,
                    "rho": -0.04,
                    "team_ratings": {},
                }
            },
        },
        "UCL",
        "promoted-home",
        "promoted-away",
    )
    assert abs(global_fallback_rates[0] - math.exp(1.0)) < 1e-12
    assert abs(global_fallback_rates[1] - math.exp(-1.0)) < 1e-12
    extreme_rates = infer_contract_rates(
        {
            "inference_contract_version": INFERENCE_CONTRACT_VERSION,
            "intercept_log": 0.0,
            "home_advantage_log": 0.0,
            "elo_coefficient": 0.0,
            "rho": 0.0,
            "team_ratings": {
                "extreme-home": {"attack": 20.0},
                "extreme-away": {"attack": -20.0},
            },
            "competition_models": {},
        },
        "TEST",
        "extreme-home",
        "extreme-away",
    )
    assert extreme_rates[:2] == (5.0, 0.15)
    with tempfile.TemporaryDirectory(prefix="betledger-self-test-") as directory:
        sample_artifact = {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "inference_parameters": inference,
        }
        path = write_artifact(Path(directory), sample_artifact, "self-test-v1")
        assert json.loads(path.read_text(encoding="utf-8")) == sample_artifact
    # Golden compatibility check from the user's spreadsheet example.
    distribution = score_matrix(1.9814, 1.2299)
    over_2_5 = sum(
        distribution[home, away]
        for home in range(distribution.shape[0])
        for away in range(distribution.shape[1])
        if home + away >= 3
    )
    assert abs(float(over_2_5) - 0.622437) < 1e-5
    print("Self-test passed: no-leak walk-forward, normalized markets, golden O/U case.")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-json", type=Path, help="Offline fixture input")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parent / "artifacts",
    )
    parser.add_argument("--dry-run", action="store_true", help="Never write Supabase")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument(
        "--trigger-type",
        choices=("scheduled", "manual", "backfill"),
        default=os.environ.get("TRAINING_TRIGGER_TYPE", "scheduled"),
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.self_test:
        self_test()
        return 0

    cutoff = utc_now()
    client: SupabaseRest | None = None
    owner_id: str | None = None
    training_run_id: str | None = None
    if args.input_json:
        fixtures = load_offline(args.input_json)
    else:
        supabase_url = os.environ.get("SUPABASE_URL", "").strip()
        service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not supabase_url or not service_role_key:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required unless --input-json is used"
            )
        client = SupabaseRest(supabase_url, service_role_key)
        owner_id = resolve_owner(client, os.environ.get("BETLEDGER_OWNER_ID"))
        fixtures = fetch_fixtures(client, owner_id)

    competition_filter = os.environ.get("COMPETITION_CODE", "").strip().upper()
    if competition_filter:
        fixtures = [
            fixture for fixture in fixtures
            if fixture.competition_code.upper() == competition_filter
        ]
    force_retrain = os.environ.get("FORCE_RETRAIN", "false").strip().lower() == "true"
    promote_if_eligible = os.environ.get("PROMOTE_IF_ELIGIBLE", "true").strip().lower() == "true"

    min_training_matches = int(os.environ.get("MIN_TRAINING_MATCHES", "100"))
    min_evaluation_fixtures = int(os.environ.get("MIN_EVALUATION_FIXTURES", "100"))
    bootstrap_samples = int(os.environ.get("BOOTSTRAP_SAMPLES", "2000"))
    sealed_season = os.environ.get("BETLEDGER_SEALED_SEASON") or None
    if len(fixtures) < min_training_matches:
        raise RuntimeError(
            f"Only {len(fixtures)} finished fixtures; at least {min_training_matches} are required"
        )
    digest = dataset_digest(fixtures)
    latest_result_at = max(result_available_at(fixture) for fixture in fixtures)

    if client and owner_id and not args.dry_run:
        previous = latest_training_run(client, owner_id)
        previous_metrics = previous.get("metrics", {}) if previous else {}
        if not force_retrain and isinstance(previous_metrics, dict) and previous_metrics.get("dataset_sha256") == digest:
            training_run_id = create_training_run(
                client, owner_id, args.trigger_type, cutoff, status="skipped"
            )
            patch_training_run(
                client,
                training_run_id,
                {
                    "last_result_at": iso_z(latest_result_at),
                    "metrics": {
                        "dataset_sha256": digest,
                        "skip_reason": "no_new_or_changed_results",
                    },
                    "completed_at": iso_z(utc_now()),
                },
            )
            print("Training skipped: no new or changed finished results.")
            return 0
        training_run_id = create_training_run(client, owner_id, args.trigger_type, cutoff)

    try:
        evaluation_rows, fold_reports = walk_forward(
            fixtures,
            min_training_matches=min_training_matches,
            sealed_season=sealed_season,
        )
        promotion = evaluate_promotion(
            evaluation_rows,
            fold_reports,
            sealed_season=sealed_season,
            min_evaluation_fixtures=min_evaluation_fixtures,
            bootstrap_samples=bootstrap_samples,
        )
        final_models, final_optimizer_success = fit_final_models(fixtures)
        inference_parameters = build_inference_parameters(final_models)
        if not final_optimizer_success:
            promotion["gates"]["optimizer_success"] = False
            promotion["promotion_eligible"] = False

        # Top-level fields intentionally mirror the promotion RPC contract.
        metrics = {
            "dataset_sha256": digest,
            "training_matches": len(fixtures),
            "evaluation_fixtures": promotion["evaluated_fixtures"],
            "sealed_season": sealed_season,
            "promotion_eligible": promotion["promotion_eligible"],
            "relative_log_loss_improvement": promotion["relative_log_loss_improvement"],
            "bootstrap_log_loss_ci_low": promotion["bootstrap_log_loss_ci_low"],
            "brier_not_worse": promotion["brier_not_worse"],
            "calibration_not_worse": promotion["calibration_not_worse"],
            "max_competition_degradation": promotion["max_competition_degradation"],
            "max_horizon_degradation": promotion["max_horizon_degradation"],
            "evaluation": promotion,
        }
        version = f"dce-elo-{cutoff.strftime('%Y%m%dT%H%M%SZ')}-{digest[:10]}"
        core_artifact = {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "feature_schema_version": FEATURE_SCHEMA_VERSION,
            "version": version,
            "generated_at": iso_z(cutoff),
            "training_cutoff": iso_z(cutoff),
            "last_result_at": iso_z(latest_result_at),
            "dataset_sha256": digest,
            "result_only": True,
            "context_adjustments_enabled": False,
            "models": final_models,
            "inference_parameters": inference_parameters,
            "metrics": metrics,
        }
        artifact_hash = sha256_json(core_artifact)
        artifact = {**core_artifact, "artifact_sha256": artifact_hash}
        artifact_path = write_artifact(args.output_dir, artifact, version)

        model_id: str | None = None
        gradient_model_id: str | None = None
        if client and owner_id and not args.dry_run:
            model_id = persist_shadow_model(
                client,
                owner_id,
                version,
                cutoff,
                artifact_hash,
                {
                    "artifact_schema_version": ARTIFACT_SCHEMA_VERSION,
                    "result_only": True,
                    **inference_parameters,
                },
                metrics,
            )
            gradient_models = {
                code: model["gradient_boosting"]
                for code, model in final_models.items()
                if model.get("gradient_boosting", {}).get("status") == "shadow"
            }
            if gradient_models:
                gradient_version = version.replace("dce-elo-", "gbt-")
                gradient_parameters = {
                    "contract_status": "shadow_only",
                    "promotion_blocker": "single_distribution_inference_contract_not_implemented",
                    "models": gradient_models,
                }
                gradient_metrics = {
                    "dataset_sha256": digest,
                    "training_matches": len(fixtures),
                    "promotion_eligible": False,
                    "promotion_blocker": "single_distribution_inference_contract_not_implemented",
                    "evaluation": promotion.get("gradient_boosting_shadow", {}),
                }
                gradient_model_id = persist_shadow_model(
                    client,
                    owner_id,
                    gradient_version,
                    cutoff,
                    sha256_json(gradient_parameters),
                    gradient_parameters,
                    gradient_metrics,
                    model_family="gradient_boosting",
                    feature_schema_version=GRADIENT_FEATURE_SCHEMA_VERSION,
                )
            if training_run_id:
                patch_training_run(
                    client,
                    training_run_id,
                    {
                        "status": "succeeded",
                        "model_version_id": model_id,
                        "last_result_at": iso_z(latest_result_at),
                        "metrics": metrics,
                        "completed_at": iso_z(utc_now()),
                    },
                )
            if metrics["promotion_eligible"] and promote_if_eligible:
                promote_model(client, owner_id, model_id)
        print(
            json.dumps(
                {
                    "status": "succeeded",
                    "artifact": str(artifact_path),
                    "training_matches": len(fixtures),
                    "evaluation_fixtures": promotion["evaluated_fixtures"],
                    "promotion_eligible": promotion["promotion_eligible"],
                    "persisted": bool(model_id),
                    "gradient_shadow_persisted": bool(gradient_model_id),
                },
                separators=(",", ":"),
            )
        )
        return 0
    except Exception as exc:
        if client and training_run_id and not args.dry_run:
            try:
                patch_training_run(
                    client,
                    training_run_id,
                    {
                        "status": "failed",
                        "error_code": type(exc).__name__[:120],
                        "error_message": safe_error(exc),
                        "completed_at": iso_z(utc_now()),
                    },
                )
            except Exception:
                pass
        raise


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(safe_error(error), file=sys.stderr)
        raise SystemExit(1)
