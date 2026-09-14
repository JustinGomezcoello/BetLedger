import { sha256Hex } from './source-extraction.ts';

type JsonRecord = Record<string, unknown>;

export const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.keys(value as JsonRecord).sort().reduce<JsonRecord>((result, key) => {
      const item = (value as JsonRecord)[key];
      if (item !== undefined) result[key] = canonicalValue(item);
      return result;
    }, {});
  }
  return value;
};

export const predictionInputHash = async (value: unknown) => (
  sha256Hex(JSON.stringify(canonicalValue(value)))
);

export const predictionGenerationHash = async (input: {
  engineVersion: string;
  fixtureId: string;
  modelVersionId: string;
  horizon: string;
  previousSnapshotAnchor: string;
  inputHash: string;
}) => sha256Hex([
  input.engineVersion,
  input.fixtureId,
  input.modelVersionId,
  input.horizon,
  input.previousSnapshotAnchor,
  input.inputHash,
].join('\n'));
