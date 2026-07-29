/**
 * ConverterService.ts
 *
 * Layer 3 of the Auto-Converter pipeline.
 *
 * Responsibilities:
 *   1. Decide which delay type(s) best fit each endpoint's observed pattern
 *   2. Run a lightweight grid search around Layer 2's derived params
 *   3. Score each candidate config with a weighted MAPE across latency / error / RPS
 *   4. Output a ConverterResult that can be patched directly into microvisim.yaml
 *
 * Delay type selection heuristics:
 *   stable      → low jitter (CV < 0.2), no drift, no load correlation
 *   jitter      → high jitter (CV ≥ 0.2), no drift, no load correlation
 *   spike       → p95/p50 ratio spikes intermittently above threshold
 *   gradualDrift → monotonically increasing p50 over time (drift detected)
 *   loadDriven  → strong positive correlation between RPS and p50 latency
 *
 * Multiple types can be combined (e.g. loadDriven + gradualDrift + spike), but only
 * ONE type ever carries the full resting latencyMs ("the baseline"). LatencySimulator
 * sums every entry in the delay array, so giving two entries the same full latencyMs
 * would double-count the endpoint's resting latency. Priority for who gets to be the
 * baseline: loadDriven > gradualDrift > jitter > stable (see buildDelays). Every other
 * structural type present becomes an overlay with latencyMs: 0, riding on top of the
 * baseline's accumulated total instead of adding a second one.
 *
 * Grid search scope (to avoid combinatorial explosion):
 *   - Only latencyMs and capacityPerReplica are grid-searched (highest impact)
 *   - jitterMs, driftRate, errorRate are fixed from Layer 2 (formula-derived)
 *   - Search range: ±30% of Layer 2 estimate, 7 steps each → 49 candidates/endpoint
 */

import { TSimulationEndpointDelay } from "../../entities/TSimConfigLoadSimulation";
import { ConvertedEndpointConfig, ConverterResult, DelayType, DerivedEndpointParams, EndpointObservedMetrics, MapeScores } from "../../entities/TSimConfigConverter";

// ─── Simulator interface (injected, avoids circular import) ──────────────────

/**
 * Minimal interface ConverterService needs from the simulator.
 * Pass in a thin wrapper around your existing LoadSimulationPropagator.
 */
export interface ISimulatorRunner {
    /**
     * Run a single-endpoint simulation for one 24-hour period.
     * @param params - The candidate config to evaluate
     * @returns Hourly arrays of p50Ms, errorRate, rps (length 24)
     */
    runEndpoint(params: SimulatorRunParams): SimulatorRunResult;
}

export interface SimulatorRunParams {
    service: string;
    endpoint: string;
    delays: TSimulationEndpointDelay[];
    capacityPerReplica: number;
    hourlyRps: number[];           // observed RPS per hour (drives load)
    replicaCount: number;
    errorRate: number;             // 0–1 fraction, fixed from Layer 2 (not grid-searched)
}

export interface SimulatorRunResult {
    p50ByHour: number[];
    errorRateByHour: number[];
    rpsByHour: number[];
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface ConverterServiceOptions {
    /** Grid search range as fraction of derived value. Default: 0.3 (±30%) */
    searchRangePct?: number;

    /** Number of steps per parameter in grid search. Default: 7 (odd = includes centre) */
    searchSteps?: number;

    /** MAPE weights. Must sum to 1. Default: latency 0.5, errorRate 0.3, rps 0.2 */
    mapeWeights?: { latency: number; errorRate: number; rps: number };

    /** p95/p50 ratio threshold above which spike type is considered. Default: 3.0 */
    spikeRatioThreshold?: number;

    /** Pearson r threshold for load-driven correlation. Default: 0.6 */
    loadCorrelationThreshold?: number;

    /** Jitter CV threshold for jitter vs stable selection. Default: 0.2 */
    jitterCvThreshold?: number;
}

export class ConverterService {
    private readonly searchRangePct: number;
    private readonly searchSteps: number;
    private readonly weights: { latency: number; errorRate: number; rps: number };
    private readonly spikeRatioThreshold: number;
    private readonly loadCorrelationThreshold: number;
    private readonly jitterCvThreshold: number;

    constructor(
        private readonly simulator: ISimulatorRunner,
        options: ConverterServiceOptions = {},
    ) {
        this.searchRangePct = options.searchRangePct ?? 0.3;
        this.searchSteps = options.searchSteps ?? 7;
        this.weights = options.mapeWeights ?? { latency: 0.5, errorRate: 0.3, rps: 0.2 };
        this.spikeRatioThreshold = options.spikeRatioThreshold ?? 3.0;
        this.loadCorrelationThreshold = options.loadCorrelationThreshold ?? 0.6;
        this.jitterCvThreshold = options.jitterCvThreshold ?? 0.2;
    }

    convert(
        metricsMap: Map<string, EndpointObservedMetrics>,
        derivedMap: Map<string, DerivedEndpointParams>,
    ): ConverterResult {
        const convertedEndpoints = new Map<string, ConvertedEndpointConfig>();

        for (const [key, observed] of metricsMap.entries()) {
            const derived = derivedMap.get(key);
            if (!derived) continue;

            convertedEndpoints.set(key, this.convertOne(observed, derived));
        }

        return {
            convertedEndpoints,
            summary: this.buildSummary(convertedEndpoints),
        };
    }

    // ─── Per-endpoint converter ──────────────────────────────────────────────

    private convertOne(
        observed: EndpointObservedMetrics,
        derived: DerivedEndpointParams,
    ): ConvertedEndpointConfig {
        // Step 1: select delay types from observed pattern
        const { selectedTypes, selectionReasons } = this.selectDelayTypes(observed, derived);

        // Step 2: build initial delay array from derived params
        const initialDelays = this.buildDelays(selectedTypes, derived, observed);

        // Step 3: grid search over latencyMs × capacityPerReplica
        const { bestDelays, bestCapacity, bestMape } = this.gridSearch(
            observed,
            derived,
            initialDelays,
        );

        return {
            service: derived.service,
            endpoint: derived.endpoint,
            delays: bestDelays,
            capacityPerReplica: bestCapacity,
            errorRatePercent: Math.round(derived.errorRate * 10000) / 100,  // 0.0023 → 0.23
            mape: bestMape,
            selectedTypes,
            selectionReasons,
        };
    }

    // ─── Delay type selection ──────────────────────────────────────────────────

    /**
     * Selects which delay type(s) best explain this endpoint's observed pattern.
     * Types are not mutually exclusive — multiple can be combined.
     *
     * Decision tree:
     *   loadDriven  → strong RPS↔latency correlation
     *   spike       → intermittent p95/p50 spikes
     *   gradualDrift → drift detected by Layer 2
     *   jitter      → high jitter CV (after removing load/drift effects)
     *   stable      → fallback if nothing else applies
     */
    private selectDelayTypes(
        observed: EndpointObservedMetrics,
        derived: DerivedEndpointParams,
    ): { selectedTypes: DelayType[]; selectionReasons: Partial<Record<DelayType, string>> } {
        const types: DelayType[] = [];
        const reasons: Partial<Record<DelayType, string>> = {};

        const rpsValues = observed.hourlyStats.map(h => h.rps);
        const p50Values = observed.hourlyStats.map(h => h.p50Ms);

        // 1. loadDriven: Pearson correlation between RPS and p50
        const loadCorr = this.pearsonCorrelation(rpsValues, p50Values);
        if (loadCorr >= this.loadCorrelationThreshold) {
            types.push("loadDriven");
            reasons["loadDriven"] = `RPS↔p50 Pearson r=${loadCorr.toFixed(2)} ≥ ${this.loadCorrelationThreshold}`;
        }

        // 2. spike: any hour has p95/p50 ratio above threshold
        const maxSpikeRatio = Math.max(
            ...observed.hourlyStats
                .filter(h => h.p50Ms > 0)
                .map(h => h.p95Ms / h.p50Ms)
        );
        if (maxSpikeRatio >= this.spikeRatioThreshold) {
            types.push("spike");
            reasons["spike"] = `max p95/p50 ratio=${maxSpikeRatio.toFixed(1)} ≥ ${this.spikeRatioThreshold}`;
        }

        // 3. gradualDrift: Layer 2 drift detection
        if (derived.hasDrift) {
            types.push("gradualDrift");
            reasons["gradualDrift"] =
                `drift slope=${derived.diagnostics.rawDriftSlopeMsPerHour.toFixed(1)} ms/hr ` +
                `(confidence: ${derived.diagnostics.driftConfidence}, mode: ${derived.driftMode})`;
        }

        // 4. baseline noise type (jitter vs stable): loadDriven and gradualDrift already
        // sample their own LogNormal noise around their own latency baseline, so adding
        // jitter/stable on top of either would double-count the resting latency. Only
        // decide jitter vs stable when neither structural driver is already present.
        const hasStructuralBaseline = types.includes("loadDriven") || types.includes("gradualDrift");
        if (!hasStructuralBaseline) {
            // Reaching here guarantees loadCorr < loadCorrelationThreshold (otherwise
            // "loadDriven" would already be in types above), so there's no load trend
            // to detrend — CV can be taken directly on the raw p50 values.
            const jitterCV = this.coefficientOfVariation(p50Values, derived.latencyMs);

            if (jitterCV >= this.jitterCvThreshold) {
                types.push("jitter");
                reasons["jitter"] = `p50 CV=${jitterCV.toFixed(2)} ≥ ${this.jitterCvThreshold}`;
            } else {
                types.push("stable");
                reasons["stable"] = `p50 CV=${jitterCV.toFixed(2)} < ${this.jitterCvThreshold}, low variance baseline`;
            }
        }

        // Ensure at least one type
        if (types.length === 0) {
            types.push("stable");
            reasons["stable"] = "fallback: no specific pattern detected";
        }

        return { selectedTypes: types, selectionReasons: reasons };
    }

    // ─── Delay array builder ───────────────────────────────────────────────────

    // Iteration order matters: "spike" reads the running total accumulated by earlier
    // entries (see LatencySimulator.computeSpike's baseLatency fallback), so it must
    // always be built last.
    private static readonly DELAY_ORDER: DelayType[] = ["loadDriven", "jitter", "stable", "gradualDrift", "spike"];

    // Which structural type gets to carry the full resting latencyMs when several are
    // present together. Everything lower in this list becomes a zero-latencyMs overlay.
    //
    // loadDriven MUST stay first: it's the only multiplicative type (latencyMs * loadFactor
    // in LatencySimulator.computeLoadDriven), so latencyMs: 0 always collapses it to 0 —
    // unlike gradualDrift (latencyMs + accumulated) or spike (falls back to the running
    // total), it can never be expressed as a zero-latencyMs overlay. It is only ever safe
    // to include loadDriven in `types` when it is meant to be the baseline.
    private static readonly BASELINE_PRIORITY: DelayType[] = ["loadDriven", "gradualDrift", "jitter", "stable"];

    private buildDelays(
        types: DelayType[],
        derived: DerivedEndpointParams,
        observed: EndpointObservedMetrics,
        latencyOverride?: number,
    ): TSimulationEndpointDelay[] {
        const latencyMs = latencyOverride ?? derived.latencyMs;
        const baselineType = ConverterService.BASELINE_PRIORITY.find(t => types.includes(t));
        const orderedTypes = ConverterService.DELAY_ORDER.filter(t => types.includes(t));
        const delays: TSimulationEndpointDelay[] = [];

        for (const type of orderedTypes) {
            const isBaseline = type === baselineType;

            switch (type) {
                case "stable":
                    // Redundant noise-only type when a structural baseline already exists
                    // (selectDelayTypes never selects it alongside one, this just mirrors
                    // that invariant here).
                    if (!isBaseline) break;
                    delays.push({ type: "stable", latencyMs, jitterMs: derived.jitterMs });
                    break;

                case "jitter":
                    if (!isBaseline) break;
                    // jitter type uses 3× jitterMs internally (see LatencySimulator computeStable)
                    // so we pass the raw jitterMs value here
                    delays.push({ type: "jitter", latencyMs, jitterMs: derived.jitterMs });
                    break;

                case "loadDriven":
                    // Always full latencyMs, never gated on isBaseline: loadDriven is rank 0
                    // in BASELINE_PRIORITY, so isBaseline is always true here by construction.
                    // (It intentionally has no zero-latencyMs overlay form — see the comment
                    // on BASELINE_PRIORITY above.)
                    delays.push({ type: "loadDriven", latencyMs, jitterMs: derived.jitterMs });
                    break;

                case "gradualDrift": {
                    // When loadDriven already owns the baseline slot, gradualDrift becomes a
                    // pure overlay: latencyMs: 0 means only the accumulated drift is added,
                    // instead of a second full resting latency.
                    const driftBaseLatency = isBaseline ? latencyMs : 0;
                    delays.push({
                        type: "gradualDrift",
                        latencyMs: driftBaseLatency,
                        jitterMs: derived.jitterMs,
                        driftRate: derived.driftRate,
                        driftMode: derived.driftMode,
                        recoveryRate: this.deriveRecoveryRate(observed, derived),
                    });
                    break;
                }

                case "spike": {
                    // latencyMs: 0 makes spike a pure overlay — LatencySimulator falls back
                    // to the running total as its base when inactive it contributes 0, and
                    // when active it adds (runningTotal × spikeMagnitude) on top.
                    const { spikeMagnitude, spikeProbability, spikeDuration } =
                        this.deriveSpikeParams(observed, latencyMs);
                    delays.push({
                        type: "spike",
                        latencyMs: 0,
                        jitterMs: derived.jitterMs,
                        spikeMagnitude,
                        spikeProbability,
                        spikeDuration,
                    });
                    break;
                }
            }
        }

        return delays;
    }

    /**
     * spikeMagnitude/spikeProbability/spikeDuration ← observed p95/p50 spike hours.
     *
     * magnitude:    median(p95Ms / baselineLatencyMs) across spiking hours — how many
     *               times the resting latency the surge actually reaches.
     * probability:  fraction of observed hours that spike — how often it happens.
     * duration:     median run-length (in hours) of consecutive spiking hours.
     *
     * Falls back to conservative defaults if no hour crosses the threshold (can happen
     * when this endpoint was flagged for "spike" via an hour excluded from the current
     * candidate window during grid search).
     */
    private deriveSpikeParams(
        observed: EndpointObservedMetrics,
        baselineLatencyMs: number,
    ): { spikeMagnitude: number; spikeProbability: number; spikeDuration: number } {
        const stats = observed.hourlyStats;
        const isSpiking = stats.map(h => h.p50Ms > 0 && h.p95Ms / h.p50Ms >= this.spikeRatioThreshold);
        const spikingCount = isSpiking.filter(Boolean).length;

        if (spikingCount === 0 || baselineLatencyMs <= 0) {
            return { spikeMagnitude: 3.0, spikeProbability: 0.05, spikeDuration: 2 };
        }

        const magnitudes = stats
            .filter((_, i) => isSpiking[i])
            .map(h => h.p95Ms / baselineLatencyMs);
        const spikeMagnitude = Math.max(1.5, Math.round(this.median(magnitudes) * 10) / 10);

        const spikeProbability = Math.min(0.5, Math.max(0.01,
            Math.round((spikingCount / stats.length) * 100) / 100));

        const runs: number[] = [];
        let runLen = 0;
        for (const spiking of isSpiking) {
            if (spiking) {
                runLen++;
            } else if (runLen > 0) {
                runs.push(runLen);
                runLen = 0;
            }
        }
        if (runLen > 0) runs.push(runLen);
        const spikeDuration = Math.max(1, Math.round(this.median(runs)));

        return { spikeMagnitude, spikeProbability, spikeDuration };
    }

    /**
     * recoveryRate ← observed p50 drop across zero-RPS gaps (ms recovered per gap),
     * used only for driftMode "request-with-recovery" where a measurable recovery
     * pattern exists. Otherwise falls back to a fraction of driftRate, since there's
     * no gap data to ground a real recovery estimate in.
     */
    private deriveRecoveryRate(observed: EndpointObservedMetrics, derived: DerivedEndpointParams): number {
        if (derived.driftMode !== "request-with-recovery") {
            return Math.max(1, Math.round(derived.driftRate * 0.4));
        }

        const stats = observed.hourlyStats;
        const drops: number[] = [];
        for (let i = 0; i < stats.length; i++) {
            if (stats[i].rps >= 0.01) continue;
            const before = i > 0 ? stats[i - 1].p50Ms : null;
            const after = i < stats.length - 1 ? stats[i + 1].p50Ms : null;
            if (before !== null && after !== null && before > after) {
                drops.push(before - after);
            }
        }

        if (drops.length === 0) return Math.max(1, Math.round(derived.driftRate * 0.4));
        return Math.max(1, Math.round(this.median(drops)));
    }

    // ─── Grid search ───────────────────────────────────────────────────────────

    private gridSearch(
        observed: EndpointObservedMetrics,
        derived: DerivedEndpointParams,
        initialDelays: TSimulationEndpointDelay[],
    ): { bestDelays: TSimulationEndpointDelay[]; bestCapacity: number; bestMape: MapeScores } {
        const latencyRange = this.buildSearchRange(derived.latencyMs, this.searchRangePct, this.searchSteps);
        const capacityRange = this.buildSearchRange(derived.capacityPerReplica, this.searchRangePct, this.searchSteps);

        let bestDelays = initialDelays;
        let bestCapacity = derived.capacityPerReplica;
        let bestMape: MapeScores = { latency: Infinity, errorRate: Infinity, rps: Infinity, weighted: Infinity };

        const hourlyRps = observed.hourlyStats.map(h => h.rps);

        for (const latencyMs of latencyRange) {
            for (const capacity of capacityRange) {
                const candidateDelays = this.buildDelays(
                    initialDelays.map(d => d.type),
                    derived,
                    observed,
                    latencyMs,
                );

                const simResult = this.simulator.runEndpoint({
                    service: derived.service,
                    endpoint: derived.endpoint,
                    delays: candidateDelays,
                    capacityPerReplica: capacity,
                    hourlyRps,
                    replicaCount: observed.hourlyStats[0]?.replicaCount ?? 1,
                    errorRate: derived.errorRate,
                });

                const mape = this.computeMape(simResult, observed);

                if (mape.weighted < bestMape.weighted) {
                    bestMape = mape;
                    bestDelays = candidateDelays;
                    bestCapacity = capacity;
                }
            }
        }

        return { bestDelays, bestCapacity, bestMape };
    }

    // ─── MAPE computation ──────────────────────────────────────────────────────

    private computeMape(
        sim: SimulatorRunResult,
        observed: EndpointObservedMetrics,
    ): MapeScores {
        const obsP50 = observed.hourlyStats.map(h => h.p50Ms);
        const obsErr = observed.hourlyStats.map(h => h.errorRate);
        const obsRps = observed.hourlyStats.map(h => h.rps);

        const latency = this.mape(sim.p50ByHour, obsP50);
        const errorRate = this.mape(sim.errorRateByHour, obsErr);
        const rps = this.mape(sim.rpsByHour, obsRps);

        const weighted =
            this.weights.latency * latency +
            this.weights.errorRate * errorRate +
            this.weights.rps * rps;

        return { latency, errorRate, rps, weighted };
    }

    private mape(predicted: number[], actual: number[]): number {
        const pairs = predicted
            .map((p, i) => ({ p, a: actual[i] ?? 0 }))
            .filter(({ a }) => a > 0);  // skip zero-actual to avoid division by zero

        if (pairs.length === 0) return 0;

        const sum = pairs.reduce((s, { p, a }) => s + Math.abs((p - a) / a), 0);
        return (sum / pairs.length) * 100;  // as percentage
    }

    // ─── Summary ───────────────────────────────────────────────────────────────

    private buildSummary(
        results: Map<string, ConvertedEndpointConfig>,
    ): ConverterResult["summary"] {
        const configs = Array.from(results.values());
        const meanWeightedMape = configs.length === 0 ? 0
            : configs.reduce((s, c) => s + c.mape.weighted, 0) / configs.length;

        const dist: Record<DelayType, number> = {
            stable: 0, jitter: 0, spike: 0, gradualDrift: 0, loadDriven: 0,
        };
        for (const c of configs) {
            for (const t of c.selectedTypes) dist[t]++;
        }

        return { meanWeightedMape, endpointCount: configs.length, delayTypeDistribution: dist };
    }

    // ─── Helpers ───────────────────────────────────────────────────────────────

    private buildSearchRange(center: number, rangePct: number, steps: number): number[] {
        const half = Math.floor(steps / 2);
        const result: number[] = [];
        for (let i = -half; i <= half; i++) {
            const v = center * (1 + (i / half) * rangePct);
            result.push(Math.max(0.01, Math.round(v * 100) / 100));
        }
        return result;
    }

    private median(values: number[]): number {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0
            ? (sorted[mid - 1] + sorted[mid]) / 2
            : sorted[mid];
    }

    /**
     * Pearson correlation coefficient between two arrays.
     */
    private pearsonCorrelation(x: number[], y: number[]): number {
        const n = Math.min(x.length, y.length);
        if (n < 2) return 0;

        const meanX = x.slice(0, n).reduce((s, v) => s + v, 0) / n;
        const meanY = y.slice(0, n).reduce((s, v) => s + v, 0) / n;

        let num = 0, denX = 0, denY = 0;
        for (let i = 0; i < n; i++) {
            const dx = x[i] - meanX;
            const dy = y[i] - meanY;
            num += dx * dy;
            denX += dx * dx;
            denY += dy * dy;
        }

        const den = Math.sqrt(denX * denY);
        return den === 0 ? 0 : num / den;
    }

    private coefficientOfVariation(values: number[], normalizeBy: number): number {
        if (values.length === 0) return 0;
        const mean = values.reduce((s, v) => s + v, 0) / values.length;
        const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
        const stdDev = Math.sqrt(variance);
        // Normalize against a stable, always-positive reference (the derived baseline
        // latency) instead of the sample's own mean, which can be zero or near-zero
        // (e.g. after OLS detrending, or for very low-latency endpoints) and make the
        // ratio blow up or become degenerate.
        return stdDev / Math.max(1, normalizeBy);
    }
}