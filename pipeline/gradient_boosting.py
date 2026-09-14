"""Dependency-light gradient-boosting shadow challenger for football results.

The production probability contract currently consumes Dixon-Coles goal rates.
This module therefore keeps gradient boosting explicitly in shadow mode: it
builds strictly pre-match form features, evaluates 1X2 probabilities, and
serializes all parameters/state needed for a future versioned inference
contract. It must not be promoted until that contract exists on both Python and
TypeScript sides.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from itertools import groupby
from typing import Any, Mapping, Sequence

import numpy as np


FEATURE_SCHEMA_VERSION = "pre-match-form-v1"

FEATURE_NAMES = (
    "elo_difference",
    "home_goals_for",
    "home_goals_against",
    "home_points_per_match",
    "away_goals_for",
    "away_goals_against",
    "away_points_per_match",
    "home_experience",
    "away_experience",
    "home_rest_days",
    "away_rest_days",
)


@dataclass
class TeamState:
    elo: float = 1500.0
    matches: int = 0
    goals_for: float = 0.0
    goals_against: float = 0.0
    points: float = 0.0
    last_kickoff: datetime | None = None


@dataclass(frozen=True)
class VectorStump:
    feature: int
    threshold: float
    left: tuple[float, float, float]
    right: tuple[float, float, float]


@dataclass(frozen=True)
class GradientBoostingModel:
    initial_logits: tuple[float, float, float]
    estimators: tuple[VectorStump, ...]
    learning_rate: float
    feature_names: tuple[str, ...]


def _result_index(fixture: Any) -> int:
    if fixture.home_score > fixture.away_score:
        return 0
    if fixture.home_score == fixture.away_score:
        return 1
    return 2


def _expected(home_elo: float, away_elo: float, home_advantage: float) -> float:
    return 1.0 / (
        1.0 + 10.0 ** (-((home_elo + home_advantage) - away_elo) / 400.0)
    )


def _rest_days(state: TeamState, kickoff: datetime) -> float:
    if state.last_kickoff is None:
        return 7.0
    days = (kickoff - state.last_kickoff).total_seconds() / 86400.0
    # Bad ordering is rejected by the caller; clipping controls long breaks.
    return float(np.clip(days, 0.0, 30.0))


def fixture_features(
    fixture: Any,
    states: Mapping[str, TeamState],
    *,
    elo_home_advantage: float = 55.0,
    prior_matches: float = 5.0,
) -> np.ndarray:
    home = states.get(fixture.home_team_id, TeamState())
    away = states.get(fixture.away_team_id, TeamState())

    def average(total: float, matches: int, prior: float) -> float:
        return (total + prior_matches * prior) / (matches + prior_matches)

    return np.asarray(
        [
            (home.elo + elo_home_advantage - away.elo) / 400.0,
            average(home.goals_for, home.matches, 1.35),
            average(home.goals_against, home.matches, 1.35),
            average(home.points, home.matches, 1.35),
            average(away.goals_for, away.matches, 1.35),
            average(away.goals_against, away.matches, 1.35),
            average(away.points, away.matches, 1.35),
            math.log1p(home.matches) / 6.0,
            math.log1p(away.matches) / 6.0,
            _rest_days(home, fixture.kickoff_at) / 14.0,
            _rest_days(away, fixture.kickoff_at) / 14.0,
        ],
        dtype=float,
    )


def update_state(
    states: dict[str, TeamState],
    fixture: Any,
    *,
    elo_k: float = 20.0,
    elo_home_advantage: float = 55.0,
) -> None:
    home = states.setdefault(fixture.home_team_id, TeamState())
    away = states.setdefault(fixture.away_team_id, TeamState())
    expected = _expected(home.elo, away.elo, elo_home_advantage)
    actual = 1.0 if fixture.home_score > fixture.away_score else (
        0.5 if fixture.home_score == fixture.away_score else 0.0
    )
    margin = abs(fixture.home_score - fixture.away_score)
    multiplier = 1.0 if margin <= 1 else math.log1p(margin)
    change = elo_k * multiplier * (actual - expected)
    home.elo += change
    away.elo -= change
    home.matches += 1
    away.matches += 1
    home.goals_for += fixture.home_score
    home.goals_against += fixture.away_score
    away.goals_for += fixture.away_score
    away.goals_against += fixture.home_score
    home.points += 3.0 if fixture.home_score > fixture.away_score else (
        1.0 if fixture.home_score == fixture.away_score else 0.0
    )
    away.points += 3.0 if fixture.away_score > fixture.home_score else (
        1.0 if fixture.home_score == fixture.away_score else 0.0
    )
    home.last_kickoff = fixture.kickoff_at
    away.last_kickoff = fixture.kickoff_at


def _result_available_at(fixture: Any) -> datetime:
    value = getattr(fixture, "result_available_at", None)
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    return fixture.kickoff_at + timedelta(hours=3)


def pre_match_dataset(
    training: Sequence[Any], testing: Sequence[Any] = ()
) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, TeamState]]:
    """Return leak-free training and sequential test features.

    Each feature vector is computed before that fixture's result mutates state.
    Test results update state only after their own vector is captured, matching
    the information that would have existed before each kickoff.
    """

    states: dict[str, TeamState] = {}
    train_features: list[np.ndarray] = []
    targets: list[int] = []
    last_kickoff: datetime | None = None
    pending_results: list[Any] = []

    def release_results(cutoff: datetime) -> None:
        ready = sorted(
            (fixture for fixture in pending_results if _result_available_at(fixture) <= cutoff),
            key=lambda item: (_result_available_at(item), item.kickoff_at, item.id),
        )
        pending_results[:] = [
            fixture for fixture in pending_results if _result_available_at(fixture) > cutoff
        ]
        for fixture in ready:
            update_state(states, fixture)

    ordered_training = sorted(training, key=lambda value: (value.kickoff_at, value.id))
    for kickoff, kickoff_rows in groupby(ordered_training, key=lambda value: value.kickoff_at):
        batch = list(kickoff_rows)
        if last_kickoff and kickoff < last_kickoff:
            raise ValueError("training fixtures are not chronological")
        release_results(kickoff)
        for fixture in batch:
            train_features.append(fixture_features(fixture, states))
            targets.append(_result_index(fixture))
        pending_results.extend(batch)
        last_kickoff = kickoff
    test_features: list[np.ndarray] = []
    ordered_testing = sorted(testing, key=lambda value: (value.kickoff_at, value.id))
    for kickoff, kickoff_rows in groupby(ordered_testing, key=lambda value: value.kickoff_at):
        batch = list(kickoff_rows)
        if last_kickoff and kickoff < last_kickoff:
            raise ValueError("test fixtures overlap training data")
        release_results(kickoff)
        for fixture in batch:
            test_features.append(fixture_features(fixture, states))
        pending_results.extend(batch)
        last_kickoff = kickoff
    for fixture in sorted(
        pending_results,
        key=lambda item: (_result_available_at(item), item.kickoff_at, item.id),
    ):
        update_state(states, fixture)
    empty = np.empty((0, len(FEATURE_NAMES)), dtype=float)
    return (
        np.vstack(train_features) if train_features else empty,
        np.asarray(targets, dtype=int),
        np.vstack(test_features) if test_features else empty,
        states,
    )


def _softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)
    values = np.exp(np.clip(shifted, -50.0, 50.0))
    return values / values.sum(axis=1, keepdims=True)


def _candidate_thresholds(values: np.ndarray, maximum: int) -> np.ndarray:
    unique = np.unique(values)
    if len(unique) < 2:
        return np.empty(0, dtype=float)
    if len(unique) <= maximum + 1:
        return (unique[:-1] + unique[1:]) / 2.0
    quantiles = np.linspace(0.03, 0.97, maximum)
    return np.unique(np.quantile(values, quantiles))


def fit_gradient_boosting(
    features: np.ndarray,
    targets: np.ndarray,
    *,
    estimators: int = 60,
    learning_rate: float = 0.06,
    max_thresholds: int = 24,
    min_leaf: int | None = None,
) -> GradientBoostingModel:
    if features.ndim != 2 or features.shape[1] != len(FEATURE_NAMES):
        raise ValueError("unexpected gradient-boosting feature shape")
    if len(features) != len(targets) or len(features) < 20:
        raise ValueError("at least 20 aligned rows are required")
    if np.any((targets < 0) | (targets > 2)):
        raise ValueError("targets must be 0, 1, or 2")
    leaf_floor = min_leaf or max(8, len(features) // 100)
    counts = np.bincount(targets, minlength=3).astype(float) + 1.0
    priors = counts / counts.sum()
    initial = np.log(priors)
    logits = np.tile(initial, (len(features), 1))
    one_hot = np.eye(3, dtype=float)[targets]
    stumps: list[VectorStump] = []
    for _ in range(estimators):
        residual = one_hot - _softmax(logits)
        best: tuple[float, int, float, np.ndarray, np.ndarray, np.ndarray] | None = None
        total_sum = residual.sum(axis=0)
        total_sse = float(np.square(residual).sum())
        for feature_index in range(features.shape[1]):
            column = features[:, feature_index]
            for threshold in _candidate_thresholds(column, max_thresholds):
                left_mask = column <= threshold
                left_count = int(left_mask.sum())
                right_count = len(column) - left_count
                if left_count < leaf_floor or right_count < leaf_floor:
                    continue
                left_sum = residual[left_mask].sum(axis=0)
                right_sum = total_sum - left_sum
                # SSE reduction for a constant vector prediction per leaf.
                gain = (
                    float(np.square(left_sum).sum()) / left_count
                    + float(np.square(right_sum).sum()) / right_count
                )
                if best is None or gain > best[0] + 1e-15:
                    best = (
                        gain,
                        feature_index,
                        float(threshold),
                        left_mask,
                        left_sum / left_count,
                        right_sum / right_count,
                    )
        if best is None or best[0] <= max(total_sse * 1e-10, 1e-12):
            break
        _, feature_index, threshold, left_mask, left_value, right_value = best
        # Centering makes each leaf invariant to the softmax additive constant.
        left_value = left_value - left_value.mean()
        right_value = right_value - right_value.mean()
        logits[left_mask] += learning_rate * left_value
        logits[~left_mask] += learning_rate * right_value
        stumps.append(
            VectorStump(
                feature=feature_index,
                threshold=threshold,
                left=tuple(float(value) for value in left_value),
                right=tuple(float(value) for value in right_value),
            )
        )
    return GradientBoostingModel(
        initial_logits=tuple(float(value) for value in initial),
        estimators=tuple(stumps),
        learning_rate=learning_rate,
        feature_names=FEATURE_NAMES,
    )


def predict_proba(model: GradientBoostingModel, features: np.ndarray) -> np.ndarray:
    if features.ndim != 2 or features.shape[1] != len(model.feature_names):
        raise ValueError("unexpected prediction feature shape")
    logits = np.tile(np.asarray(model.initial_logits, dtype=float), (len(features), 1))
    for stump in model.estimators:
        left_mask = features[:, stump.feature] <= stump.threshold
        logits[left_mask] += model.learning_rate * np.asarray(stump.left)
        logits[~left_mask] += model.learning_rate * np.asarray(stump.right)
    return _softmax(logits)


def serialize_model(
    model: GradientBoostingModel, states: Mapping[str, TeamState]
) -> dict[str, Any]:
    return {
        "family": "gradient_boosted_vector_stumps",
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "feature_names": list(model.feature_names),
        "initial_logits": list(model.initial_logits),
        "learning_rate": model.learning_rate,
        "estimators": [asdict(estimator) for estimator in model.estimators],
        "team_state": {
            team: {
                "elo": value.elo,
                "matches": value.matches,
                "goals_for": value.goals_for,
                "goals_against": value.goals_against,
                "points": value.points,
                "last_kickoff": value.last_kickoff.isoformat() if value.last_kickoff else None,
            }
            for team, value in sorted(states.items())
        },
    }


def self_test() -> None:
    class Match:
        def __init__(self, index: int, home: str, away: str, hg: int, ag: int) -> None:
            self.id = str(index)
            self.kickoff_at = datetime.fromisoformat(f"2024-01-{index + 1:02d}T12:00:00+00:00")
            self.home_team_id = home
            self.away_team_id = away
            self.home_score = hg
            self.away_score = ag

    rows = [
        Match(index, "a" if index % 2 == 0 else "b", "b" if index % 2 == 0 else "a", 2 if index % 3 else 0, 1)
        for index in range(28)
    ]
    train_x, targets, test_x, states = pre_match_dataset(rows[:24], rows[24:])
    model = fit_gradient_boosting(train_x, targets, estimators=8, min_leaf=4)
    probabilities = predict_proba(model, test_x)
    assert probabilities.shape == (4, 3)
    assert np.allclose(probabilities.sum(axis=1), 1.0)
    assert np.all(probabilities > 0.0)
    payload = serialize_model(model, states)
    assert payload["feature_schema_version"] == FEATURE_SCHEMA_VERSION
    assert payload["team_state"]

    simultaneous_a = Match(0, "shared", "x", 5, 0)
    simultaneous_b = Match(1, "shared", "y", 0, 2)
    simultaneous_a.id = "simultaneous-a"
    simultaneous_b.id = "simultaneous-b"
    simultaneous_b.kickoff_at = simultaneous_a.kickoff_at
    simultaneous_x, _, _, _ = pre_match_dataset([simultaneous_a, simultaneous_b])
    home_experience_index = FEATURE_NAMES.index("home_experience")
    assert simultaneous_x[0, home_experience_index] == 0.0
    assert simultaneous_x[1, home_experience_index] == 0.0

    early = Match(0, "shared-hour", "x-hour", 4, 0)
    before_result = Match(1, "shared-hour", "y-hour", 0, 1)
    before_result.kickoff_at = early.kickoff_at + timedelta(hours=1)
    delayed_x, _, _, _ = pre_match_dataset([early, before_result])
    assert delayed_x[1, home_experience_index] == 0.0

    after_result = Match(2, "shared-hour", "z-hour", 1, 1)
    after_result.kickoff_at = early.kickoff_at + timedelta(hours=4)
    released_x, _, _, _ = pre_match_dataset([early, after_result])
    assert released_x[1, home_experience_index] > 0.0


if __name__ == "__main__":
    self_test()
    print("Self-test passed: leak-free features and normalized GBT probabilities.")
