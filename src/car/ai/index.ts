/**
 * AI rivals — see RivalDriver.ts (the driver), RivalField.ts (the race as
 * the rivals see it + frame order), grid.ts (starting grid, who races).
 */
export { RivalDriver, rivalParams, hash01 } from './RivalDriver';
export type { FastCarRule, RivalMode, RivalOptions, RivalParams, RivalRescueReason } from './RivalDriver';
export { RivalField, MAX_RUBBER_BAND } from './RivalField';
export type { FieldRival, RescuePose, RivalFieldOptions } from './RivalField';
export { CarTracker } from './CarTracker';
export { RaceLine, TrackGeometry } from './RaceLine';
export type { RaceLineOptions, RivalTrack, TrackProjection } from './RaceLine';
export { DIFFICULTY_PRESETS, RACE_CAR_IDS, buildField, gridPoses } from './grid';
export type { DifficultyPreset, FieldEntry, FieldOptions, GridOptions, GridPose } from './grid';
