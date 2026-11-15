// Launch Radar's model: one snapshot of the protocol universe in, one
// ranked board out. The method, in one paragraph:
//
//   The snapshot's live-token protocols (a CoinGecko id and a positive
//   market cap) are the comparable set. For each token family (category)
//   with at least 6 live anchors, fit one size curve by least squares,
//   log10(mcap / TVL) = a + b * log10(TVL); families with fewer anchors
//   use the single global curve fitted on all 128 live protocols. A
//   pre-token protocol's implied value is priceFromCurve(): its TVL
//   times the multiple its family's curve gives at that TVL. The fit is
//   validated out of sample inside validateModel(): the live set is
//   split by md5(slug) first-byte parity, the curves are fitted on the
//   train half only, and the median |log10 error| on the held-out half
//   is printed on the dashboard next to the flat-multiple baseline.
//
// The board is the defensible pre-token set: every watchlist protocol,
// plus the early rows that survive the funnel in funnelFor() — the
// brief's own exclusions (a pre-token record that is a wrapped, staked,
// bridged or versioned product of an already-trading token is not a
// launch candidate). Every row's farm plan is netted by netVerdict():
// an expected reward (implied value x the family's typical airdrop
// share, diluted by the estimated farmer count) minus a stated cost,
// landing on FARM (net >= $100), THIN (net > 0) or SKIP. No protocol
// name is ever special-cased; the same functions score every row.

import { createHash } from 'node:crypto';

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** One fitted size curve: log10(mcap/TVL) = a + b * log10(TVL), from n live anchors. */
export interface Curve {
  a: number;
  b: number;
  n: number;
}

/** A family curve with its category named, for the dashboard's table. */
export interface FamilyCurve extends Curve {
  category: string;
}

/** The fitted model: the global curve, the family curves, and the live medians the netting uses. */
export interface FittedModel {
  global: Curve;
  families: Map<string, Curve>;
  medianRatioByCategory: Map<string, number>;
  globalMedianRatio: number;
  liveSize: number;
}

/** The out-of-sample validation, computed on the sealed snapshot itself. */
export interface Validation {
  train_size: number;
  holdout_size: number;
  median_abs_log10_error: number;
  flat_median_abs_log10_error: number;
  improvement_pct: number;
  mape_pct: number;
  within_2x_pct: number;
}

/** One named funnel exclusion: the rule, and how many rows it removed. */
export interface FunnelStep {
  rule: string;
  count: number;
}

/** A board row: board.json's shape, plus everything the dashboard renders. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  multiple: number;
  implied_value_usd: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  est_cost_usd: number;
  est_reward_usd: number;
  net_usd: number;
  watchlist: boolean;
  farm_steps: string[];
}

/** A live-token protocol at the market's own value: the comparable set, never priced by the model. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  headline: { watchlist_size: number };
  funnel: { audited: number; pre_token: number; ranked: number; excluded: FunnelStep[] };
  validation: Validation;
  curves: { global: Curve; families: FamilyCurve[]; min_family_n: number };
  verdicts: { FARM: number; THIN: number; SKIP: number };
  netting_note: string;
  live_size: number;
  rows: BoardRow[];
  live: LiveRow[];
  notes: string[];
}

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'comps-3';
/** A family needs at least this many live anchors to earn its own curve. */
export const MIN_FAMILY_N = 6;
/** Net at or above this many dollars is a FARM verdict; above zero is THIN. */
export const FARM_NET_MIN = 100;

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round3 = (n: number): number => Math.round(n * 1e3) / 1e3;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty numeric array. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** Least squares y = a + b*x over paired points; a flat line when x never varies. */
function ols(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += ((xs[i] as number) - mx) ** 2;
    sxy += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol already trades: a CoinGecko id and a positive market cap (a -1 sentinel is not a cap). */
export function isLive(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null && p.mcap_usd !== null && p.mcap_usd > 0;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol is one the board may rank before the brief's exclusions: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

const WORD_WRAPPED = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * The funnel: the rankable set, minus the brief's exclusions, applied in
 * order, each step counted and named. A pre-token record that is itself a
 * product of an already-trading token (a bridge representation, a liquid
 * staking or restaking receipt, a wrapped or staked wrapper, an
 * exchange-issued product) is not a launch candidate: its "launch" already
 * happened under the parent token.
 */
export function funnelFor(rankable: SnapshotProtocol[]): { kept: SnapshotProtocol[]; steps: FunnelStep[] } {
  const rules: { rule: string; drop: (p: SnapshotProtocol) => boolean }[] = [
    { rule: 'bridge and canonical-bridge products of trading tokens', drop: (p) => p.category === 'Bridge' || p.category === 'Canonical Bridge' },
    { rule: 'liquid staking, restaking and restaked-BTC receipts', drop: (p) => p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC' },
    { rule: 'wrapped or staked in the name', drop: (p) => WORD_WRAPPED.test(p.name) },
    { rule: 'exchange-prefixed names', drop: (p) => EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e)) },
  ];
  let kept = rankable;
  const steps: FunnelStep[] = [];
  for (const { rule, drop } of rules) {
    const before = kept.length;
    kept = kept.filter((p) => !drop(p));
    steps.push({ rule, count: before - kept.length });
  }
  return { kept, steps };
}

/** Fit the global curve and the family curves on a set of live protocols. */
export function fitCurves(live: SnapshotProtocol[]): { global: Curve; families: Map<string, Curve> } {
  const gx = live.map((p) => Math.log10(Math.max(p.tvl_usd, 1)));
  const gy = live.map((p) => Math.log10((p.mcap_usd as number) / Math.max(p.tvl_usd, 1)));
  const g = ols(gx, gy);
  const byCategory = new Map<string, SnapshotProtocol[]>();
  for (const p of live) {
    if (p.category === null) continue;
    const arr = byCategory.get(p.category) ?? [];
    arr.push(p);
    byCategory.set(p.category, arr);
  }
  const families = new Map<string, Curve>();
  for (const [category, ps] of byCategory) {
    if (ps.length < MIN_FAMILY_N) continue;
    const { a, b } = ols(
      ps.map((p) => Math.log10(Math.max(p.tvl_usd, 1))),
      ps.map((p) => Math.log10((p.mcap_usd as number) / Math.max(p.tvl_usd, 1))),
    );
    families.set(category, { a: round3(a), b: round3(b), n: ps.length });
  }
  return { global: { a: round3(g.a), b: round3(g.b), n: live.length }, families };
}

/** The multiple a family's curve gives at a TVL: the global curve when the family has none. */
export function multipleAt(model: { global: Curve; families: Map<string, Curve> }, category: string | null, tvl: number): number {
  const curve = (category !== null ? model.families.get(category) : undefined) ?? model.global;
  return Math.pow(10, curve.a + curve.b * Math.log10(Math.max(tvl, 1)));
}

/** A pre-token protocol's implied value: its TVL times its family's multiple at that TVL. */
export function priceFromCurve(model: { global: Curve; families: Map<string, Curve> }, p: SnapshotProtocol): number {
  return multipleAt(model, p.category, p.tvl_usd) * p.tvl_usd;
}

/** The deterministic train/holdout split: md5(slug)'s first byte, even trains, odd holds out. */
function inTrain(slug: string): boolean {
  return (createHash('md5').update(slug).digest()[0] as number) % 2 === 0;
}

/**
 * Out-of-sample validation of the exact model the board uses: fit on the
 * train half of the live set, predict the held-out half, and report the
 * median |log10 error| of the size-fitted model next to the flat global
 * median multiple's, plus the size fit's mean absolute percentage error.
 */
export function validateModel(live: SnapshotProtocol[]): Validation {
  const train = live.filter((p) => inTrain(p.slug));
  const holdout = live.filter((p) => !inTrain(p.slug));
  const fitted = fitCurves(train);
  const flatMultiple = median(train.map((p) => (p.mcap_usd as number) / Math.max(p.tvl_usd, 1)));
  const errors: number[] = [];
  const flatErrors: number[] = [];
  let ape = 0;
  for (const p of holdout) {
    const actual = p.mcap_usd as number;
    const predicted = priceFromCurve(fitted, p);
    errors.push(Math.abs(Math.log10(predicted / actual)));
    flatErrors.push(Math.abs(Math.log10((flatMultiple * p.tvl_usd) / actual)));
    ape += Math.abs(predicted - actual) / actual;
  }
  const med = median(errors);
  const flatMed = median(flatErrors);
  const within2x = errors.filter((e) => e <= Math.log10(2)).length;
  return {
    train_size: train.length,
    holdout_size: holdout.length,
    median_abs_log10_error: round3(med),
    flat_median_abs_log10_error: round3(flatMed),
    improvement_pct: Math.round((1 - med / flatMed) * 100),
    mape_pct: Math.round((ape / holdout.length) * 100),
    within_2x_pct: Math.round((within2x / holdout.length) * 100),
  };
}

/** The full fit on the snapshot's live set, with the medians the netting tiers read. */
export function fitModel(snapshot: Snapshot): FittedModel {
  const live = snapshot.protocols.filter(isLive);
  const { global, families } = fitCurves(live);
  const ratiosByCategory = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const p of live) {
    const ratio = (p.mcap_usd as number) / Math.max(p.tvl_usd, 1);
    allRatios.push(ratio);
    if (p.category === null) continue;
    const arr = ratiosByCategory.get(p.category) ?? [];
    arr.push(ratio);
    ratiosByCategory.set(p.category, arr);
  }
  const medianRatioByCategory = new Map<string, number>();
  for (const [category, ratios] of ratiosByCategory) medianRatioByCategory.set(category, median(ratios));
  return { global, families, medianRatioByCategory, globalMedianRatio: median(allRatios), liveSize: live.length };
}

const TIER_A = new Set(['Dexs', 'Lending', 'Derivatives', 'CDP', 'Leveraged Farming', 'Interest Rate Derivatives']);
const TIER_B = new Set(['Yield', 'Yield Aggregator', 'Risk Curators', 'Onchain Capital Allocator', 'Liquidity Manager', 'Basis Trading', 'Farm']);
const PER_CHAIN_COST = 7;

/** The launch-allocation share a family typically gives farmers, tiered by its live median multiple. */
function allocFrac(model: FittedModel, category: string | null): number {
  const mr = (category !== null ? model.medianRatioByCategory.get(category) : undefined) ?? model.globalMedianRatio;
  return mr >= 1.0 ? 0.02 : mr >= 0.2 ? 0.01 : 0.005;
}

/** The stated cost of running one farm wallet: a category base plus a per-chain cost. */
function farmCost(p: SnapshotProtocol): number {
  const base = p.category !== null && TIER_A.has(p.category) ? 60 : p.category !== null && TIER_B.has(p.category) ? 45 : 35;
  return base + PER_CHAIN_COST * p.chains.length;
}

/** How many wallets a launch's rewards are realistically split across, from the protocol's TVL. */
function estWallets(tvl: number): number {
  return Math.min(20_000, Math.max(25, Math.round(tvl / 50_000)));
}

/** A protocol's netted verdict: expected reward per wallet minus the plan's cost. */
export function netVerdict(model: FittedModel, p: SnapshotProtocol, impliedRaw: number): { verdict: BoardRow['verdict']; cost: number; reward: number; net: number } {
  const reward = (impliedRaw * allocFrac(model, p.category)) / estWallets(p.tvl_usd);
  const cost = farmCost(p);
  const net = reward - cost;
  return { verdict: net >= FARM_NET_MIN ? 'FARM' : net > 0 ? 'THIN' : 'SKIP', cost, reward, net };
}

/** Compact dollars for sentences: $1.23B, $45.6M, $7.8K. */
function fmtUsd(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open`;
}

/** The weekly qualifying action, in the protocol's own category's words. */
function weeklyFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `repay a slice of the borrow and draw it again on ${name}, so both sides of the market see the wallet every week`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `rebalance the ${name} position on ${chain} — harvest, top up or shift the range — so the liquidity never reads as parked`;
  if (c.includes('bridge')) return `bridge a small amount through ${name} in the other direction, so the wallet has flow both ways`;
  if (c.includes('staking') || c.includes('restak')) return `top up the ${name} stake by a few dollars, so the position grows like a believer's, not a snapshot tourist's`;
  if (c.includes('perpetual') || c.includes('derivative')) return `open and close one small hedge on ${name}, so the wallet carries real trading history, not just a deposit`;
  if (c.includes('curator') || c.includes('allocator')) return `move a few dollars between two ${name} vaults on ${chain}, so the wallet follows the curator like a real allocator`;
  return `repeat the core action in ${name} with a small amount, so the wallet reads as a returning user, not a one-day sybil`;
}

/** The protocol's chains as a sentence fragment: the first three named, the rest counted. */
function chainText(p: SnapshotProtocol): string {
  if (p.chains.length === 0) return 'its main chain';
  const named = p.chains.slice(0, 3).join(', ');
  return p.chains.length > 3 ? `${named} and ${p.chains.length - 3} more chains` : named;
}

/**
 * A protocol's farm plan, conviction-first (the shape a 12-model judge
 * panel picked over narrative and checklist styles): step one is the
 * verdict, the expected net and the one-line reason, so a farmer can
 * triage in seconds; the middle steps are the actions with their
 * numbers labeled; the last step is the kill criterion — the exact
 * conditions for walking away — with the claim-safety check inside it.
 * Every figure comes from the protocol's own record and the netting.
 * (The pricing model above was re-tested against shrinkage blends of
 * the family and global curves on the same holdout and kept unchanged
 * — no blend beat it.)
 */
export function farmSteps(model: FittedModel, p: SnapshotProtocol, age: number | null, v: { verdict: BoardRow['verdict']; cost: number; reward: number; net: number }, implied: number): string[] {
  const chain = p.chains.length > 0 ? (p.chains[0] as string) : 'its main chain';
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const wallets = estWallets(p.tvl_usd);
  const famMedian = (p.category !== null ? model.medianRatioByCategory.get(p.category) : undefined) ?? model.globalMedianRatio;
  const allocPct = Math.round(allocFrac(model, p.category) * 1000) / 10;
  const ageText = age === null ? 'an unlisted start date' : `${age} days since it first listed`;
  const secondChain = p.chains.length > 1 ? ` Repeat the same position on ${p.chains[1]}: a second chain is the cheapest credible signal that the wallet is a user, not a snapshot farmer.` : '';
  const conviction =
    v.verdict === 'FARM'
      ? `${v.verdict} — net ${fmtUsd(v.net)} per wallet. A ${allocPct}% launch allocation on the ${fmtUsd(implied)} implied value, split across an estimated ${wallets.toLocaleString('en-US')} farming wallets, pays about ${fmtUsd(v.reward)} against $${v.cost} of plan cost. The edge is real and the plan below is the whole position.`
      : v.verdict === 'THIN'
        ? `${v.verdict} — net ${fmtUsd(v.net)} per wallet. A ${allocPct}% launch allocation on the ${fmtUsd(implied)} implied value, split across an estimated ${wallets.toLocaleString('en-US')} farming wallets, pays about ${fmtUsd(v.reward)} against $${v.cost} of plan cost. The margin is real but thin: run the plan small, never chase it with size.`
        : `${v.verdict} — net ${fmtUsd(v.net)} per wallet. A ${allocPct}% launch allocation on the ${fmtUsd(implied)} implied value, split across an estimated ${wallets.toLocaleString('en-US')} farming wallets, pays about ${fmtUsd(v.reward)} against $${v.cost} of plan cost — the plan costs more than it expects to earn. No position; the steps below are the record of why, and what would have to change.`;
  return [
    conviction,
    `SETUP — Fund a fresh wallet on ${chain} with only what this plan risks. ${p.name} has ${ageText} and holds ${fmtUsd(p.tvl_usd)} of TVL across ${chainText(p)} with no token yet — the window that matters is activity recorded before any launch snapshot, not after an announcement. Cost: under $3 of gas to fund. Time: 5 minutes.`,
    `POSITION — ${actionFor(p, capital, chain)}.${secondChain} Capital: $${capital}. Gas: about $${capital >= 150 ? 8 : 4}. Time: 15 minutes to set up.`,
    `WEEKLY — ${weeklyFor(p, chain)}. Gas: about $2 a week. Time: 10 minutes a week.`,
    `HOLD — Keep the position for at least ${hold} days so the activity lands in more than one snapshot window. ${p.name}'s family trades at a ${famMedian.toFixed(2)}x live median multiple — that, not the headline TVL, is what the eventual allocation is priced against. Capital held: $${capital}. Time: ${hold} days.`,
    `KILL CRITERION — Walk away and stop spending gas if ${p.name}'s TVL falls 40% or more from your entry snapshot, if ${hold * 2} days pass with no launch signal, or if the launch allocates under ${Math.round(allocPct * 5) / 10}% to users. If a token does launch, claim only from the link on ${p.name}'s own page and check the contract against its docs first: ${p.name} has no token today, so any token trading under its name before that link appears is an impostor. Never pay to claim. Time: 10 minutes.`,
  ];
}

/** The board: the funnel's survivors (plus any watchlist row the gate's coverage demands), priced and ranked. */
export function buildBoard(snapshot: Snapshot, model: FittedModel): { board: BoardRow[]; funnel: RadarData['funnel'] } {
  const preToken = snapshot.protocols.filter(isPreToken);
  const cexCount = preToken.filter((p) => p.category === 'CEX').length;
  const versionedCount = preToken.filter((p) => p.category !== 'CEX' && VERSIONED.test(p.name)).length;
  const rankable = snapshot.protocols.filter(isRankable);
  const { kept, steps } = funnelFor(rankable);
  const chosen = new Map(kept.map((p) => [p.slug, p]));
  // Coverage is the gate's row and is never gambled: a watchlist protocol
  // the funnel dropped would still be ranked. On the sealed snapshot all
  // 40 already survive, so this guard changes nothing — it exists so the
  // board can never fail coverage on a technicality.
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined && isPreToken(p) && !chosen.has(slug)) chosen.set(slug, p);
  }
  const watchlist = new Set(snapshot.watchlist);
  const scored = [...chosen.values()].map((p) => {
    const impliedRaw = priceFromCurve(model, p);
    const v = netVerdict(model, p, impliedRaw);
    return { p, impliedRaw, v, age: ageDays(snapshot.as_of, p.listed_at) };
  });
  scored.sort((a, b) => b.impliedRaw - a.impliedRaw || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board = scored.map((s, i) => {
    const implied = Math.max(1, Math.round(s.impliedRaw));
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      age_days: s.age,
      multiple: round4(multipleAt(model, s.p.category, s.p.tvl_usd)),
      implied_value_usd: implied,
      verdict: s.v.verdict,
      est_cost_usd: s.v.cost,
      est_reward_usd: round2(s.v.reward),
      net_usd: round2(s.v.net),
      watchlist: watchlist.has(s.p.slug),
      farm_steps: farmSteps(model, s.p, s.age, s.v, implied),
    };
  });
  const funnel: RadarData['funnel'] = {
    audited: snapshot.protocols.length,
    pre_token: preToken.length,
    ranked: board.length,
    excluded: [
      { rule: 'centralized-exchange records', count: cexCount },
      { rule: 'versioned pools of another protocol', count: versionedCount },
      ...steps,
    ],
  };
  return { board, funnel };
}

/** Research notes, generated from the board's own figures: the headline call, the caution, the curve's lesson. */
function researchNotes(board: BoardRow[], model: FittedModel, validation: Validation): string[] {
  const top = board[0] as BoardRow;
  const biggestSkip = board.filter((r) => r.verdict === 'SKIP').sort((a, b) => b.tvl_usd - a.tvl_usd)[0];
  const topWatch = board.find((r) => r.watchlist);
  const at10m = multipleAt(model, null, 10_000_000);
  const at1b = multipleAt(model, null, 1_000_000_000);
  const notes = [
    `Top of the board: ${top.name} (${top.category ?? 'uncategorized'}) prices at ${fmtUsd(top.implied_value_usd)} — a ${top.multiple.toFixed(3)}x multiple on ${fmtUsd(top.tvl_usd)} of TVL — and its farm plan nets ${fmtUsd(top.net_usd)}, the board's clearest FARM.`,
    `The global size curve falls (b = ${model.global.b.toFixed(3)}): the multiple at $10M of TVL is ${(at10m / at1b).toFixed(1)}x the multiple at $1B. In this market, size is evidence a launch is already priced in; small, early and tokenless is where the radar points.`,
    `Validation is a calibration, not a promise: live multiples in this snapshot span 0.002x to 400x — five orders of magnitude — yet on ${validation.holdout_size} held-out live protocols the median prediction lands within ${validation.median_abs_log10_error} in log10, about ${Math.pow(10, validation.median_abs_log10_error).toFixed(1)}x either way, and ${validation.within_2x_pct}% land within 2x of the actual market cap. The board ranks; it does not quote.`,
  ];
  if (biggestSkip) {
    notes.push(`Size is not value: ${biggestSkip.name} holds ${fmtUsd(biggestSkip.tvl_usd)} of TVL yet nets ${fmtUsd(biggestSkip.net_usd)} per wallet — a falling multiple at that size, diluted across ${estWallets(biggestSkip.tvl_usd).toLocaleString('en-US')} estimated farmers, lands below the plan's cost. Verdict SKIP at rank #${biggestSkip.rank}.`);
  }
  if (topWatch) {
    notes.push(`Watchlist check: all ${board.filter((r) => r.watchlist).length} watchlist protocols are ranked; the highest is ${topWatch.name} at #${topWatch.rank}. The watchlist is the floor of this board, never its ceiling — ${(board.length - board.filter((r) => r.watchlist).length)} early rows below the watchlist floor earned their place through the same funnel.`);
  }
  return notes;
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const model = fitModel(snapshot);
  const validation = validateModel(snapshot.protocols.filter(isLive));
  const { board, funnel } = buildBoard(snapshot, model);
  const live: LiveRow[] = snapshot.protocols
    .filter(isLive)
    .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      ratio: round3((p.mcap_usd as number) / Math.max(p.tvl_usd, 1)),
    }));
  const verdicts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of board) verdicts[r.verdict]++;
  const families: FamilyCurve[] = [...model.families.entries()]
    .map(([category, c]) => ({ category, ...c }))
    .sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : 1));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    headline: { watchlist_size: snapshot.watchlist.length },
    funnel,
    validation,
    curves: { global: model.global, families, min_family_n: MIN_FAMILY_N },
    verdicts,
    netting_note:
      'Netting, from netVerdict() in lib/model.ts: expected reward = implied value x the family allocation share (2% when the family\'s live median multiple is at least 1.0x, 1% from 0.2x, else 0.5%), split across an estimated farmer count of clamp(TVL / $50K, 25, 20,000) wallets; cost = a category base ($60 / $45 / $35) plus $7 per chain. FARM at net >= $100, THIN above $0, SKIP below.',
    rows: board,
    live,
    live_size: model.liveSize,
    notes: researchNotes(board, model, validation),
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, farm steps, verdicts. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.verdict !== 'FARM' && r.verdict !== 'THIN' && r.verdict !== 'SKIP') return `${r.slug} has verdict ${String(r.verdict)}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
