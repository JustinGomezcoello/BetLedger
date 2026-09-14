import type {
  ContextFactor,
  PredictionHorizon,
  PredictionMarket,
} from './types.ts'

export type SupportedCompetition =
  | 'premier_league'
  | 'la_liga'
  | 'bundesliga'
  | 'champions_league'
  | 'europa_league'
  | 'conference_league'

export type ObjectiveState =
  | 'secured'
  | 'alive'
  | 'eliminated'
  | 'conditional_external'
  | 'unknown'

export type EvidenceAuthority =
  | 'official'
  | 'structured_provider'
  | 'reliable_press'
  | 'community'
  | 'rumor'

export type ContextReviewStatus = 'pending' | 'approved' | 'corrected' | 'rejected'

export interface ContextObservation {
  readonly id: string
  readonly fixtureId: string
  readonly teamId: string | null
  readonly playerId: string | null
  readonly factor: ContextFactor
  readonly authority: EvidenceAuthority
  readonly certainty: number
  readonly factualSummary: string
  readonly sourceUrl: string
  readonly sourceHash: string
  readonly publishedAt: string | null
  readonly observedAt: string
  readonly fetchedAt: string
  readonly validFrom: string | null
  readonly expiresAt: string | null
  readonly hasConflict: boolean
  readonly reviewStatus: ContextReviewStatus
  /** True only after the source family and this observation pass their gates. */
  readonly affectsModel: boolean
}

export type SyncScope = 'all' | 'competition' | 'date' | 'fixture'

export interface SyncRequest {
  readonly scope: SyncScope
  readonly competition?: SupportedCompetition
  readonly date?: string
  readonly fixtureId?: string
  readonly requestedBy: string
  readonly priority: 'normal' | 'lineup_window'
  readonly idempotencyKey: string
}

export interface PredictionQuery {
  readonly competition?: SupportedCompetition
  readonly dateFrom?: string
  readonly dateTo?: string
  readonly market?: PredictionMarket
  readonly horizon?: PredictionHorizon
}
