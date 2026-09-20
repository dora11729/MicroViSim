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
 * ── UNITS ──────────────────────────────────────────────────────────────────────
 * Calibration runs at the CSV's own resolution (observed.slotDurationSeconds), so every
 * time-dependent quantity here — driftRate, recoveryRate, spikeDuration,
 * spikeProbability — is in PER-CALIBRATION-SLOT units while the grid search runs.
 * `toHourlyEmitUnits` converts them to the target simulator's per-hour units at the very
 * end, because the real simulator's slot is hardcoded to one hour. Duration-independent
 * params (latencyMs, jitterMs, spikeMagnitude, errorRate, capacityPerReplica) pass
 * through unchanged.
 *
 * Grid search scope (to avoid combinatorial explosion):
 *   - Only latencyMs and capacityPerReplica are grid-searched (highest impact)
 *   - jitterMs, driftRate, errorRate are fixed from Layer 2 (formula-derived)
 *   - capacityPerReplica is only searched for loadDriven endpoints (see gridSearch)
 */

import { TSimulationEndpointDelay } from "../../entities/TSimConfigLoadSimulation";
import {
    ConvertedEndpointConfig,
    ConverterResult,
    DelayType,
    DerivedEndpointParams,
    EndpointObservedMetrics,
    MapeScores,
    SlotModel,
    slotsPerHourFor,
} from "../../entities/TSimConfigConverter";
import { MetricsExtractor } from "./MetricsExtractor";

// ─── Simulator interface (injected, avoids circular import) ──────────────────

/**
 * Minimal interface ConverterService needs from the simulator.
 * Pass in a thin wrapper around your existing LoadSimulationPropagator.
 */
export interface ISimulatorRunner {
    /**
     * Run a single-endpoint simulation over the observed window.
     * @param params - The candidate config to evaluate
     * @returns Per-slot arrays, all the same length as params.slotRps
     */
    runEndpoint(params: SimulatorRunParams): SimulatorRunResult;
}

export interface SimulatorRunParams {
    service: string;
    endpoint: string;
    delays: TSimulationEndpointDelay[];
    capacityPerReplica: number;
    slotRps: number[];             // observed RPS per slot (drives load)
    /**
     * Per-slot replica count (same indexing as slotRps), not a single constant —
     * a service that autoscales has a different replica count at its peak slot than at
     * slot 0, and Layer 2's capacityPerReplica is derived from replicaCountAtPeak
     * specifically, so the peak slot must be simulated with its own real replica count.
     */
    slotReplicaCount: number[];
    /** Wall-clock length of one slot; needed to keep loadDriven's utilisation honest. */
    slotDurationSeconds: number;
    errorRate: number;             // 0–1 fraction, fixed from Layer 2 (not grid-searched)
}

export interface SimulatorRunResult {
    p50BySlot: number[];
    errorRateBySlot: number[];
    /**
     * Echoes the observed RPS — the propagator does not throttle entry points on the
     * calibration path, so simulated RPS is definitionally the input RPS. Kept because
     * mape.rps is still reported, but it carries no ranking signal (see computeMape).
     */
    rpsBySlot: number[];
    /** Requests actually simulated per slot. Drives the MAPE comparability mask. */
    simulatedRequestCountBySlot: number[];
    /** Own-errors actually simulated per slot. Drives the pooled error-rate MAPE. */
    simulatedErrorCountBySlot: number[];
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

    /**
     * How many times to re-run the simulator per grid-search candidate, taking the median
     * of the MAPE scores. The simulator is stochastic (Math.random()-driven latency/error
     * sampling), so a single run is a noisy point estimate of a candidate's true MAPE;
     * aggregating over several runs makes the winning candidate reproducible in practice
     * instead of possibly being picked by chance. Default: 5.
     */
    mapeSamplesPerCandidate?: number;
}

export class ConverterService {
    private readonly searchRangePct: number;
    private readonly searchSteps: number;
    private readonly weights: { latency: number; errorRate: number; rps: number };
    private readonly spikeRatioThreshold: number;
    private readonly loadCorrelationThreshold: number;
    private readonly mapeSamplesPerCandidate: number;

    constructor(
        private readonly simulator: ISimulatorRunner,
        options: ConverterServiceOptions = {},
    ) {
        this.searchRangePct = options.searchRangePct ?? 0.3;
        this.searchSteps = options.searchSteps ?? 7;
        this.weights = options.mapeWeights ?? { latency: 0.5, errorRate: 0.3, rps: 0.2 };
        this.spikeRatioThreshold = options.spikeRatioThreshold ?? 3.0;
        this.loadCorrelationThreshold = options.loadCorrelationThreshold ?? 0.6;
        this.mapeSamplesPerCandidate = options.mapeSamplesPerCandidate ?? 3;

        this.validateOptions();
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

        // Step 2: build initial delay array from derived params (per-slot units)
        const initialDelays = this.buildDelays(selectedTypes, derived, observed);

        // Step 3: grid search over latencyMs × capacityPerReplica
        const { bestDelays, bestCapacity, bestMape } = this.gridSearch(
            observed,
            derived,
            initialDelays,
        );

        // Step 4: convert per-slot quantities to the target simulator's per-hour units
        const slotsPerHour = slotsPerHourFor(observed.slotDurationSeconds);
        const emittedDelays = this.toHourlyEmitUnits(bestDelays, slotsPerHour);

        const slotModel = this.buildSlotModel(observed, derived, bestMape);
        this.annotateUnitConversion(selectionReasons, bestDelays, emittedDelays, observed, slotsPerHour);

        return {
            service: derived.service,
            endpoint: derived.endpoint,
            delays: emittedDelays,
            capacityPerReplica: bestCapacity,
            errorRatePercent: Math.round(derived.errorRate * 10000) / 100,  // 0.0023 → 0.23
            mape: bestMape,
            selectedTypes,
            selectionReasons,
            slotModel,
        };
    }

    // ─── Delay type selection ──────────────────────────────────────────────────

    /**
     * Selects which delay type(s) best explain this endpoint's observed pattern.
     * Types are not mutually exclusive — multiple can be combined.
     *
     * All the statistics here summarise OBSERVED behaviour, so they run over non-gap
     * slots only: a gap slot's p50/p95 are carried forward from the previous real slot
     * and its rps/errorRate are synthetic zeros.
     */
    private selectDelayTypes(
        observed: EndpointObservedMetrics,
        derived: DerivedEndpointParams,
    ): { selectedTypes: DelayType[]; selectionReasons: Partial<Record<DelayType, string>> } {
        const types: DelayType[] = [];
        const reasons: Partial<Record<DelayType, string>> = {};

        // Too few slots to distinguish any pattern. Degrade to stable with an explicit
        // reason rather than reporting a correlation fitted to three points.
        if (observed.slotStats.length < MetricsExtractor.MIN_SLOTS_FOR_STATS) {
            return {
                selectedTypes: ["jitter"],
                selectionReasons: {
                    jitter:
                        `only ${observed.slotStats.length} time slot(s) of ` +
                        `${observed.slotDurationSeconds}s (${Math.round(observed.observedSpanSeconds)}s observed); ` +
                        `at least ${MetricsExtractor.MIN_SLOTS_FOR_STATS} are needed to distinguish ` +
                        `load-driven / drift / spike behaviour. Falling back to a plain jitter ` +
                        `delay with latencyMs and jitterMs taken from the available sample(s).`,
                },
            };
        }

        // Filtering one array keeps rps↔p50 pairing intact.
        const realSlots = observed.slotStats.filter(s => !s.isGap);
        const rpsValues = realSlots.map(s => s.rps);
        const p50Values = realSlots.map(s => s.p50Ms);

        // 1. loadDriven: Pearson correlation between RPS and p50
        const loadCorr = this.pearsonCorrelation(rpsValues, p50Values);
        if (loadCorr >= this.loadCorrelationThreshold) {
            types.push("loadDriven");
            reasons["loadDriven"] = `RPS↔p50 Pearson r=${loadCorr.toFixed(2)} ≥ ${this.loadCorrelationThreshold}`;
        }

        // 2. spike: any slot has p95/p50 ratio above threshold
        const spikeRatios = realSlots.filter(s => s.p50Ms > 0).map(s => s.p95Ms / s.p50Ms);
        // Math.max(...[]) is -Infinity, which would silently never trip the threshold.
        const maxSpikeRatio = spikeRatios.length > 0 ? Math.max(...spikeRatios) : 0;
        if (maxSpikeRatio >= this.spikeRatioThreshold) {
            types.push("spike");
            reasons["spike"] = `max p95/p50 ratio=${maxSpikeRatio.toFixed(1)} ≥ ${this.spikeRatioThreshold}`;
        }

        // 3. gradualDrift: Layer 2 drift detection (thresholded on the ms/hour slope)
        if (derived.hasDrift) {
            types.push("gradualDrift");
            reasons["gradualDrift"] =
                `drift slope=${derived.diagnostics.rawDriftSlopeMsPerHour.toFixed(1)} ms/hr ` +
                `(confidence: ${derived.diagnostics.driftConfidence}, mode: ${derived.driftMode})`;
        }

        // 4. baseline noise: loadDriven and gradualDrift already sample their own LogNormal
        // noise around their own latency baseline, so adding jitter on top of either would
        // double-count the resting latency.
        const hasStructuralBaseline = types.includes("loadDriven") || types.includes("gradualDrift");
        if (!hasStructuralBaseline) {
            const jitterCV = this.coefficientOfVariation(p50Values, derived.latencyMs);
            types.push("jitter");
            reasons["jitter"] = `baseline noise, p50 CV=${jitterCV.toFixed(2)}`;
            // Explain a degenerate correlation rather than silently reporting r=0.00.
            if (loadCorr === 0 && this.isConstant(p50Values)) {
                reasons["jitter"] +=
                    `; observed p50 is constant across all ${p50Values.length} slots, ` +
                    `so no load correlation is computable`;
            }
        }

        // Defensive: the branch above already guarantees a baseline whenever no structural
        // driver was detected.
        if (types.length === 0) {
            types.push("jitter");
            reasons["jitter"] = "fallback: no specific pattern detected";
        }

        return { selectedTypes: types, selectionReasons: reasons };
    }

    // ─── Delay array builder ───────────────────────────────────────────────────

    // Iteration order matters: "spike" reads the running total accumulated by earlier
    // entries (see LatencySimulator.computeSpike's baseLatency fallback), so it must
    // always be built last.
    private static readonly DELAY_ORDER: DelayType[] = ["loadDriven", "jitter", "gradualDrift", "spike"];

    // Which structural type gets to carry the full resting latencyMs when several are
    // present together. Everything lower in this list becomes a zero-latencyMs overlay.
    //
    // loadDriven MUST stay first: it's the only multiplicative type (latencyMs * loadFactor
    // in LatencySimulator.computeLoadDriven), so latencyMs: 0 always collapses it to 0 —
    // unlike gradualDrift (latencyMs + accumulated) or spike (falls back to the running
    // total), it can never be expressed as a zero-latencyMs overlay. It is only ever safe
    // to include loadDriven in `types` when it is meant to be the baseline.
    private static readonly BASELINE_PRIORITY: DelayType[] = ["loadDriven", "gradualDrift", "jitter"];

    /** Builds the delay array in PER-CALIBRATION-SLOT units. */
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
                case "jitter":
                    // Redundant noise-only type when a structural baseline already exists
                    // (selectDelayTypes never selects it alongside one, this just mirrors
                    // that invariant here).
                    if (!isBaseline) break;
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
                        driftRate: derived.driftRatePerSlot,
                        driftMode: derived.driftMode,
                        recoveryRate: this.deriveRecoveryRate(observed, derived),
                    });
                    break;
                }

                case "spike": {
                    // latencyMs: 0 makes spike a pure overlay — LatencySimulator falls back
                    // to the running total as its base; when inactive it contributes 0, and
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
     * spikeMagnitude / duty cycle / duration ← observed p95/p50 spike slots.
     *
     * magnitude:  median(p95Ms / baselineLatencyMs) across spiking slots — how many times
     *             the resting latency the surge actually reaches.
     * duration:   median run-length (in SLOTS) of consecutive spiking slots.
     * probability: derived FROM the duty cycle, not equal to it — see spikeProbabilityFor.
     *
     * Falls back to conservative defaults if no slot crosses the threshold.
     */
    private deriveSpikeParams(
        observed: EndpointObservedMetrics,
        baselineLatencyMs: number,
    ): { spikeMagnitude: number; spikeProbability: number; spikeDuration: number } {
        const stats = observed.slotStats;
        // A gap slot carries forward the previous slot's p95/p50, so its ratio would
        // spuriously extend a spike run. No traffic happened there — treat as not spiking.
        const isSpiking = stats.map(s =>
            !s.isGap && s.p50Ms > 0 && s.p95Ms / s.p50Ms >= this.spikeRatioThreshold);
        const spikingCount = isSpiking.filter(Boolean).length;
        const realSlotCount = stats.filter(s => !s.isGap).length;

        if (spikingCount === 0 || realSlotCount === 0 || baselineLatencyMs <= 0) {
            return { spikeMagnitude: 3.0, spikeProbability: 0.05, spikeDuration: 2 };
        }

        const magnitudes = stats
            .filter((_, i) => isSpiking[i])
            .map(s => s.p95Ms / baselineLatencyMs);
        const spikeMagnitude = Math.max(1.5, Math.round(this.median(magnitudes) * 10) / 10);

        // Run-length scan walks the full array so adjacency is real time adjacency;
        // gaps read as non-spiking and therefore correctly break a run.
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

        const dutyCycle = spikingCount / realSlotCount;
        return {
            spikeMagnitude,
            spikeProbability: this.spikeProbabilityFor(dutyCycle, spikeDuration),
            spikeDuration,
        };
    }

    /**
     * Solves the per-slot trigger probability that reproduces an observed duty cycle at a
     * given spike duration.
     *
     * LatencySimulator.advanceSpike's process is: `d` active slots, then exactly one
     * forced-inactive slot, then a Geometric(p) wait. Expected inactive slots per cycle is
     * `1 + (1-p)/p = 1/p`, so the fraction of time spent spiking is
     *
     *     dutyCycle = d / (d + 1/p) = (p·d) / (1 + p·d)
     *
     * Inverting gives `p = f / (d·(1-f))`. Using the duty cycle *directly* as the trigger
     * probability (what this used to do) is only valid when p·d << 1 — at f=0.2, d=3 the
     * resulting model actually spikes 37.5% of the time, nearly double the observation.
     */
    private spikeProbabilityFor(dutyCycle: number, durationSlots: number): number {
        const d = Math.max(1, durationSlots);
        // 0.95 guard: p diverges as f → 1.
        const f = Math.min(0.95, Math.max(0, dutyCycle));
        const p = f / (d * (1 - f));
        return Math.min(1, Math.max(0.01, Math.round(p * 100) / 100));
    }

    /**
     * recoveryRate ← observed p50 drop across zero-RPS gaps (ms recovered per SLOT),
     * used only for driftMode "request-with-recovery" where a measurable recovery
     * pattern exists. Otherwise falls back to a fraction of driftRate, since there's
     * no gap data to ground a real recovery estimate in.
     *
     * Walks the full array: it reasons about before/after adjacency around idle slots.
     */
    private deriveRecoveryRate(observed: EndpointObservedMetrics, derived: DerivedEndpointParams): number {
        const fallback = Math.max(0, Math.round(derived.driftRatePerSlot * 0.4 * 10000) / 10000);
        if (derived.driftMode !== "request-with-recovery") return fallback;

        const stats = observed.slotStats;
        const drops: number[] = [];
        for (let i = 0; i < stats.length; i++) {
            if (stats[i].rps >= 0.01) continue;
            const before = i > 0 ? stats[i - 1].p50Ms : null;
            const after = i < stats.length - 1 ? stats[i + 1].p50Ms : null;
            if (before !== null && after !== null && before > after) {
                drops.push(before - after);
            }
        }

        if (drops.length === 0) return fallback;
        return Math.max(0, Math.round(this.median(drops) * 10000) / 10000);
    }

    // ─── Emit-time unit conversion ─────────────────────────────────────────────

    /**
     * Converts a calibrated delay array from per-calibration-slot units to the per-hour
     * units the real simulator expects (its slot is hardcoded to one hour).
     *
     * Done here rather than at derivation time because LatencySimulator.advanceDrift and
     * advanceSpike are called once per slot: feeding a per-hour driftRate into a
     * 60-slot-per-hour calibration would accumulate drift 60× too fast, so every candidate
     * would be scored against a simulation resembling neither the observation nor the
     * emitted config.
     *
     * driftRate / recoveryRate are exact under this conversion (accumulation is linear in
     * slot count). spikeDuration / spikeProbability are approximate — an hourly simulator
     * cannot represent a sub-hour spike at all, so the conversion preserves the DUTY CYCLE
     * (mean latency inflation over time) and gives up the temporal shape.
     */
    private toHourlyEmitUnits(
        delays: TSimulationEndpointDelay[],
        slotsPerHour: number,
    ): TSimulationEndpointDelay[] {
        const round2 = (v: number) => Math.round(v * 100) / 100;

        return delays.map(d => {
            switch (d.type) {
                case "gradualDrift":
                    return {
                        ...d,
                        driftRate: Math.max(0, round2(d.driftRate * slotsPerHour)),
                        recoveryRate: Math.max(0, round2(d.recoveryRate * slotsPerHour)),
                    };

                case "spike": {
                    // Recover the duty cycle the calibration values encode, then re-solve
                    // for p at the coarser hourly duration so the fraction of time spent
                    // spiking is preserved.
                    //
                    // NOT 1-(1-p)^M (probability of at least one spike per hour): with
                    // spikeDuration floored at 1 hour that turns a 10%-of-the-time spike
                    // into a ~100%-of-the-time spike (1 - 0.9^60 = 0.998).
                    const pd = d.spikeProbability * d.spikeDuration;
                    const dutyCycle = pd / (1 + pd);
                    const durationHours = Math.max(1, Math.round(d.spikeDuration / slotsPerHour));
                    return {
                        ...d,
                        spikeDuration: durationHours,
                        spikeProbability: this.spikeProbabilityFor(dutyCycle, durationHours),
                    };
                }

                default:
                    // stable / jitter / loadDriven are duration-independent.
                    return d;
            }
        });
    }

    private buildSlotModel(
        observed: EndpointObservedMetrics,
        derived: DerivedEndpointParams,
        mape: MapeScores,
    ): SlotModel {
        const notes: string[] = [];

        if (derived.diagnostics.insufficientSlots) {
            notes.push(
                `only ${observed.slotStats.length} slot(s) available; pattern detection ` +
                `(load correlation / drift / spike) was skipped.`,
            );
        }

        // The emitted config is replayed over 24–168 hourly slots (simulationDurationInDays
        // is 1–7), so a per-hour drift rate extrapolated from a sub-hour window compounds
        // far beyond anything that was observed.
        if (derived.hasDrift && observed.observedSpanSeconds < 3600) {
            const slotsPerHour = slotsPerHourFor(observed.slotDurationSeconds);
            const perHour = derived.driftRatePerSlot * slotsPerHour;
            notes.push(
                `drift measured over only ${(observed.observedSpanSeconds / 60).toFixed(1)} min; ` +
                `extrapolated to ${perHour.toFixed(1)} ms/hour it reaches ` +
                `~${Math.round(perHour * 24)} ms after one simulated day. ` +
                `Consider setting maxLatencyMs on this endpoint.`,
            );
        }

        if (mape.comparedSlotCount < MetricsExtractor.MIN_SLOTS_FOR_STATS) {
            notes.push(
                `MAPE was computed over only ${mape.comparedSlotCount} comparable slot(s); ` +
                `treat the fit score as indicative rather than conclusive.`,
            );
        }

        return {
            slotDurationSeconds: observed.slotDurationSeconds,
            nativeIntervalSeconds: observed.nativeIntervalSeconds,
            slotCount: observed.slotStats.length,
            observedSpanSeconds: observed.observedSpanSeconds,
            reason:
                `${observed.slotStats.length} × ${observed.slotDurationSeconds}s slots over ` +
                `${Math.round(observed.observedSpanSeconds)}s of observed data ` +
                `(${observed.slotGridReason})`,
            notes,
        };
    }

    /** Appends the per-slot → per-hour translation to the affected types' reasons. */
    private annotateUnitConversion(
        reasons: Partial<Record<DelayType, string>>,
        calibrated: TSimulationEndpointDelay[],
        emitted: TSimulationEndpointDelay[],
        observed: EndpointObservedMetrics,
        slotsPerHour: number,
    ): void {
        if (observed.slotDurationSeconds === 3600) return; // identity, nothing to explain

        const d = observed.slotDurationSeconds;

        const calDrift = calibrated.find(x => x.type === "gradualDrift");
        const emitDrift = emitted.find(x => x.type === "gradualDrift");
        if (calDrift?.type === "gradualDrift" && emitDrift?.type === "gradualDrift" && reasons["gradualDrift"]) {
            reasons["gradualDrift"] +=
                `; calibrated at ${d}s resolution, driftRate ${calDrift.driftRate} ms/slot ` +
                `emitted as ${emitDrift.driftRate} ms/hour (×${slotsPerHour.toFixed(0)})`;
        }

        const calSpike = calibrated.find(x => x.type === "spike");
        const emitSpike = emitted.find(x => x.type === "spike");
        if (calSpike?.type === "spike" && emitSpike?.type === "spike" && reasons["spike"]) {
            const pd = calSpike.spikeProbability * calSpike.spikeDuration;
            const dutyCycle = pd / (1 + pd);
            reasons["spike"] +=
                `; ${calSpike.spikeDuration} × ${d}s spikes emitted as ` +
                `${emitSpike.spikeDuration} × 1h spikes with p ${calSpike.spikeProbability} → ` +
                `${emitSpike.spikeProbability} to preserve the ${(dutyCycle * 100).toFixed(1)}% ` +
                `duty cycle — sub-hour spike shape is not representable at the simulator's ` +
                `1-hour resolution`;
        }
    }

    // ─── Grid search ───────────────────────────────────────────────────────────

    private gridSearch(
        observed: EndpointObservedMetrics,
        derived: DerivedEndpointParams,
        initialDelays: TSimulationEndpointDelay[],
    ): { bestDelays: TSimulationEndpointDelay[]; bestCapacity: number; bestMape: MapeScores } {
        const latencyRange = this.buildSearchRange(derived.latencyMs, this.searchRangePct, this.searchSteps);

        // capacityPerReplica only ever reaches LatencySimulator.computeLoadDriven. With no
        // loadDriven entry in the delay array it is read and discarded, so searching it is
        // searchSteps identical simulations whose winner is decided by simulator noise.
        const searchesCapacity = initialDelays.some(d => d.type === "loadDriven");
        const capacityRange = searchesCapacity
            ? this.buildSearchRange(derived.capacityPerReplica, this.searchRangePct, this.searchSteps)
            : [derived.capacityPerReplica];

        let bestDelays = initialDelays;
        let bestCapacity = derived.capacityPerReplica;
        let bestMape: MapeScores = {
            latency: Infinity, errorRate: Infinity, rps: Infinity, weighted: Infinity,
            weightedStdDev: Infinity, sampleCount: 0, comparedSlotCount: 0,
        };

        const slotRps = observed.slotStats.map(s => s.rps);

        for (const latencyMs of latencyRange) {
            for (const capacity of capacityRange) {
                const candidateDelays = this.buildDelays(
                    initialDelays.map(d => d.type),
                    derived,
                    observed,
                    latencyMs,
                );

                const mape = this.evaluateCandidate(derived, candidateDelays, capacity, slotRps, observed);

                if (mape.weighted < bestMape.weighted) {
                    bestMape = mape;
                    bestDelays = candidateDelays;
                    bestCapacity = capacity;
                }
            }
        }

        return { bestDelays, bestCapacity, bestMape };
    }

    /**
     * Runs one candidate through the (stochastic) simulator `mapeSamplesPerCandidate`
     * times and takes the median of the resulting MAPE scores, so the candidate
     * comparison isn't decided by a single noisy sample or skewed by an occasional
     * outlier run (e.g. one sample happening to roll a rare spike).
     */
    private evaluateCandidate(
        derived: DerivedEndpointParams,
        delays: TSimulationEndpointDelay[],
        capacity: number,
        slotRps: number[],
        observed: EndpointObservedMetrics,
    ): MapeScores {
        const samples: MapeScores[] = [];
        const slotReplicaCount = observed.slotStats.map(s => Math.max(1, s.replicaCount));

        for (let i = 0; i < this.mapeSamplesPerCandidate; i++) {
            const simResult = this.simulator.runEndpoint({
                service: derived.service,
                endpoint: derived.endpoint,
                delays,
                capacityPerReplica: capacity,
                slotRps,
                slotReplicaCount,
                slotDurationSeconds: observed.slotDurationSeconds,
                errorRate: derived.errorRate,
            });

            samples.push(this.computeMape(simResult, observed));
        }

        return this.aggregateMape(samples);
    }

    private aggregateMape(samples: MapeScores[]): MapeScores {
        const n = samples.length;

        const latency = this.median(samples.map(s => s.latency));
        const errorRate = this.median(samples.map(s => s.errorRate));
        const rps = this.median(samples.map(s => s.rps));
        const comparedSlotCount = Math.round(this.median(samples.map(s => s.comparedSlotCount)));

        // Recomputed from the per-metric medians rather than taking the median of
        // each sample's already-combined `weighted` value: median doesn't distribute
        // over a weighted sum the way mean does, so the latter would make `weighted`
        // stop matching 0.5*latency + 0.3*errorRate + 0.2*rps for the reported numbers.
        const weighted =
            this.weights.latency * latency +
            this.weights.errorRate * errorRate +
            this.weights.rps * rps;

        // Spread of the per-sample weighted scores around this median-based center —
        // still a useful stability indicator even though the center isn't the mean.
        const weightedVariance = samples.reduce((sum, s) => sum + (s.weighted - weighted) ** 2, 0) / n;
        const weightedStdDev = Math.sqrt(weightedVariance);

        return { latency, errorRate, rps, weighted, weightedStdDev, sampleCount: n, comparedSlotCount };
    }

    // ─── MAPE computation (single simulation run) ──────────────────────────────

    private computeMape(
        sim: SimulatorRunResult,
        observed: EndpointObservedMetrics,
    ): MapeScores {
        const obsP50 = observed.slotStats.map(s => s.p50Ms);
        const obsErr = observed.slotStats.map(s => s.errorRate);
        const obsRps = observed.slotStats.map(s => s.rps);

        // A slot is comparable only if it carries real observed traffic (not a
        // carried-forward gap fill) AND the simulator actually produced requests for it
        // AND those requests yielded at least one 200-status latency sample
        // (latencyStatsByStatus has no "200" bucket when every request in the slot
        // errored). Scoring the others compares a carried-forward observation against a
        // structural zero and charges 100% for it — that is what made the latency MAPE
        // bottom out near 95.8% regardless of the candidate.
        const mask = observed.slotStats.map((s, i) =>
            !s.isGap
            && s.rps > 0
            && (sim.simulatedRequestCountBySlot[i] ?? 0) > 0
            && (sim.p50BySlot[i] ?? 0) > 0);

        const comparedSlotCount = mask.filter(Boolean).length;

        const latency = this.mape(sim.p50BySlot, obsP50, mask);
        const errorRate = this.pooledErrorRateMape(sim, obsErr, obsRps, mask);
        // Structurally 0 — the adapter echoes observed RPS because the calibration path
        // never throttles entry points. Same constant for every candidate, so it does not
        // affect ranking; it does systematically deflate the reported `weighted` score by
        // its full weight. Kept because it is still displayed.
        const rps = this.mape(sim.rpsBySlot, obsRps, mask);

        const weighted =
            this.weights.latency * latency +
            this.weights.errorRate * errorRate +
            this.weights.rps * rps;

        // Single-run sample: stability fields aren't meaningful yet, only aggregateMape's
        // output (across several of these samples) is reported to callers.
        return { latency, errorRate, rps, weighted, weightedStdDev: 0, sampleCount: 1, comparedSlotCount };
    }

    private mape(predicted: number[], actual: number[], mask: boolean[]): number {
        const pairs = predicted
            .map((p, i) => ({ p, a: actual[i] ?? 0, ok: mask[i] ?? true }))
            .filter(({ a, ok }) => ok && a > 0);  // a > 0 is the division guard only

        if (pairs.length === 0) return 0;

        const sum = pairs.reduce((s, { p, a }) => s + Math.abs((p - a) / a), 0);
        return (sum / pairs.length) * 100;  // as percentage
    }

    /**
     * Error-rate MAPE pooled across slots rather than averaged per-slot.
     *
     * Per-slot error rates quantize to 1/requestsPerSlot: at 50 requests per slot and an
     * error rate of 0.002 the expected error count is 0.1, so nearly every slot reports
     * exactly 0 against a non-zero observation and contributes a full 100%. Pooling over
     * the whole run makes the estimate usable, which matters because this term still
     * carries weight in the ranking.
     */
    private pooledErrorRateMape(
        sim: SimulatorRunResult,
        obsErr: number[],
        obsRps: number[],
        mask: boolean[],
    ): number {
        let simRequests = 0;
        let simErrors = 0;
        let obsWeight = 0;
        let obsWeighted = 0;

        for (let i = 0; i < mask.length; i++) {
            if (!mask[i]) continue;
            simRequests += sim.simulatedRequestCountBySlot[i] ?? 0;
            simErrors += sim.simulatedErrorCountBySlot[i] ?? 0;
            // Weight the observed rate by traffic so busy slots dominate, matching how the
            // pooled simulated rate is formed.
            const w = obsRps[i] ?? 0;
            obsWeight += w;
            obsWeighted += w * (obsErr[i] ?? 0);
        }

        if (simRequests === 0 || obsWeight === 0) return 0;

        const obsPooled = obsWeighted / obsWeight;
        if (obsPooled <= 0) return 0;

        const simPooled = simErrors / simRequests;
        return Math.abs(simPooled - obsPooled) / obsPooled * 100;
    }

    // ─── Summary ───────────────────────────────────────────────────────────────

    private buildSummary(
        results: Map<string, ConvertedEndpointConfig>,
    ): ConverterResult["summary"] {
        const configs = Array.from(results.values());
        const meanWeightedMape = configs.length === 0 ? 0
            : configs.reduce((s, c) => s + c.mape.weighted, 0) / configs.length;

        const dist: Record<DelayType, number> = {
            jitter: 0, spike: 0, gradualDrift: 0, loadDriven: 0,
        };
        for (const c of configs) {
            for (const t of c.selectedTypes) dist[t]++;
        }

        return { meanWeightedMape, endpointCount: configs.length, delayTypeDistribution: dist };
    }

    // ─── Helpers ───────────────────────────────────────────────────────────────

    private buildSearchRange(center: number, rangePct: number, steps: number): number[] {
        const half = Math.floor(steps / 2);
        if (half === 0) {
            // steps === 1: no actual search, just evaluate the derived center value.
            // (half would otherwise be the divisor in `i / half` below — 0/0 is NaN.)
            return [Math.max(0.01, Math.round(center * 100) / 100)];
        }
        const result: number[] = [];
        for (let i = -half; i <= half; i++) {
            const v = center * (1 + (i / half) * rangePct);
            result.push(Math.max(0.01, Math.round(v * 100) / 100));
        }
        return result;
    }

    /**
     * Validates user-configurable options at construction time (this class is fed
     * directly from HTTP request options via ConverterHandler, so this is a real
     * trust boundary). Throws a clear Error — ConverterHandler's catch already turns
     * that into a 400 response — instead of letting bad options silently corrupt the
     * grid search (e.g. searchSteps <= 0 makes buildSearchRange return an empty range,
     * so the loop in gridSearch never runs and every endpoint's mape stays stuck at
     * the Infinity sentinel).
     */
    private validateOptions(): void {
        if (!Number.isInteger(this.searchSteps) || this.searchSteps < 1) {
            throw new Error(`searchSteps must be a positive integer, got ${this.searchSteps}.`);
        }
        if (!(this.searchRangePct > 0)) {
            throw new Error(`searchRangePct must be greater than 0, got ${this.searchRangePct}.`);
        }
        if (!Number.isInteger(this.mapeSamplesPerCandidate) || this.mapeSamplesPerCandidate < 1) {
            throw new Error(`mapeSamplesPerCandidate must be a positive integer, got ${this.mapeSamplesPerCandidate}.`);
        }
        const weightSum = this.weights.latency + this.weights.errorRate + this.weights.rps;
        if (Math.abs(weightSum - 1) > 0.01) {
            throw new Error(`mapeWeights must sum to 1, got ${weightSum.toFixed(3)}.`);
        }
    }

    private median(values: number[]): number {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0
            ? (sorted[mid - 1] + sorted[mid]) / 2
            : sorted[mid];
    }

    private isConstant(values: number[]): boolean {
        if (values.length < 2) return true;
        return values.every(v => v === values[0]);
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
        // for very low-latency endpoints and make the ratio blow up or become degenerate.
        return stdDev / Math.max(1, normalizeBy);
    }
}
