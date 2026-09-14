import { supabase } from './supabase';

export type BankrollProfile = {
  id: string;
  name?: string;
  starting_bankroll: number;
  current_bankroll: number;
  stake10_percent: number;
  use_compounding: boolean;
};

export type ChannelBankroll = {
  id: string;
  profile_id: string;
  channel_name: string;
  starting_bankroll: number;
  current_bankroll: number;
  stake_scale: number;
  max_stake_norm?: number;
};

export type ManualBet = {
  id: string;
  profile_id: string;
  bet_date: string;
  bet_type: 'single' | 'double' | 'parlay';
  category: string | null;
  selection: string;
  description: string | null;
  odds: number;
  stake_norm: number;
  stake_amount: number;
  status: 'pending' | 'won' | 'lost' | 'void' | 'cancelled';
  profit: number | null;
  channel: string | null;
  tipster_amount: number | null;
  tipster_profit: number | null;
  recommendation_id?: string | null;
};

export type MonthlyConfig = {
  id: string;
  profile_id: string;
  month: string;
  starting_bankroll: number;
};

export type ManualBetInput = {
  profile_id?: string;
  bet_date: string;
  bet_type: ManualBet['bet_type'];
  category: string;
  selection: string;
  description?: string;
  odds: number;
  stake_norm: number;
  channel: string;
  tipster_amount?: number | null;
  is_tracking: boolean;
};

const rpc = async <T>(name: string, parameters: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.rpc(name, parameters);
  if (error) throw error;
  return data as T;
};

export const placeManualBet = (input: ManualBetInput, idempotencyKey = crypto.randomUUID()) => (
  rpc<ManualBet>('place_manual_bet', {
    p_input: input,
    p_idempotency_key: idempotencyKey,
  })
);

export const settleManualBet = (betId: string, status: 'won' | 'lost' | 'void') => (
  rpc<ManualBet>('settle_manual_bet', {
    p_bet_id: betId,
    p_status: status,
    p_idempotency_key: `settle:${betId}:${status}`,
  })
);

export const cancelManualBet = (betId: string) => (
  rpc<ManualBet>('cancel_manual_bet', {
    p_bet_id: betId,
    p_idempotency_key: `cancel:${betId}`,
  })
);

export const updateBankrollSettings = (
  profileId: string,
  startingBankroll: number,
  stake10Percent: number,
  useCompounding: boolean,
) => rpc<BankrollProfile>('update_bankroll_settings', {
  p_profile_id: profileId,
  p_starting_bankroll: startingBankroll,
  p_stake10_percent: stake10Percent,
  p_use_compounding: useCompounding,
});

export const updateChannelSettings = (
  channelId: string,
  startingBankroll: number,
  maxStakeNorm: number,
) => rpc<ChannelBankroll>('update_channel_bankroll_settings', {
  p_channel_id: channelId,
  p_starting_bankroll: startingBankroll,
  p_max_stake_norm: maxStakeNorm,
});

export const adjustBankroll = (
  profileId: string,
  channelName: string | null,
  newBalance: number,
  reason: string,
) => rpc<Record<string, unknown>>('adjust_bankroll', {
  p_profile_id: profileId,
  p_channel_name: channelName,
  p_new_balance: newBalance,
  p_reason: reason,
  p_idempotency_key: crypto.randomUUID(),
});

export const upsertMonthlyConfig = (
  profileId: string,
  month: string,
  startingBankroll: number,
) => rpc<MonthlyConfig>('upsert_monthly_config', {
  p_profile_id: profileId,
  p_month: month,
  p_starting_bankroll: startingBankroll,
});

export const errorMessage = (error: unknown, fallback: string) => (
  error instanceof Error ? error.message : fallback
);
