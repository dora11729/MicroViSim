/**
 * SimulatorRunnerAdapter.ts
 *
 * Adapts LoadSimulationPropagator to the ISimulatorRunner interface
 * required by ConverterService.
 *
 * Runs the calibration at the CSV's own time resolution (slotDurationSeconds), which
 * is generally NOT one hour. See the rho comment in runEndpoint for how that is made
 * to work against a simulator whose slot is hardcoded to an hour.
 */

import LoadSimulationPropagator from "../LoadSimulation/LoadSimulationPropagator";
import {
    ISimulatorRunner,
    SimulatorRunParams,
    SimulatorRunResult,
} from "./ConverterService";
import { TCMetricsPerTimeSlot, TDependOnMapWithCallProbability } from "../../entities/TLoadSimulation";
import { TSimulationEndpointMetric } from "../../entities/TSimConfigLoadSimulation";

export class SimulatorRunnerAdapter implements ISimulatorRunner {
    private readonly propagator = new LoadSimulationPropagator();

    /**
     * Total simulated requests per run, summed over all slots. Bounding the TOTAL rather
     * than the per-slot count keeps grid-search cost independent of slot count:
     * cost ≈ MAX_REQUESTS_PER_RUN × candidates × mapeSamplesPerCandidate.
     *
     * Down-scaling doesn't change success/failure ratios (error injection is a per-request
     * Bernoulli draw, so subsampling preserves the expected ratio), but it DOES change
     * loadDriven's utilisation — which is why the capacity is scaled by the same factor
     * in the loop below.
     */
    private static readonly MAX_REQUESTS_PER_RUN = 6000;

    /**
     * Floor so the per-slot mean latency stays a usable estimate at high slot counts.
     * At n=50 with a latency CV around 0.3 the per-slot mean carries ~4% noise, which
     * shows up as a roughly constant offset in every candidate's MAPE and so does not
     * affect ranking.
     */
    private static readonly MIN_REQUESTS_PER_SLOT = 50;

    runEndpoint(params: SimulatorRunParams): SimulatorRunResult {
        const {
            service,
            endpoint,
            delays,
            capacityPerReplica,
            slotRps,
            slotReplicaCount,
            slotDurationSeconds,
            errorRate,
        } = params;

        // uniqueEndpointName 格式需與專案其他地方一致
        const uniqueEndpointName = `${service}-${endpoint}`;
        const uniqueServiceName = service;

        // ── 1. TSimulationEndpointMetric[] ───────────────────────────────────
        // 校準時以 leaf node 跑（無 dependOn）。uniqueEndpointName 必須設定，
        // 否則 LoadSimulationPropagator 的 drift/spike 狀態推進與 FallbackHandler
        // 的策略查找都會用 undefined/"" 當 key，永遠對不上下面 per-slot map 用的
        // 真實 uniqueEndpointName。

        const endpointMetrics: TSimulationEndpointMetric[] = [
            {
                endpointId: endpoint,
                errorRatePercent: Math.round(errorRate * 10000) / 100,
                delay: delays,
                maxLatencyMs: 0,
                timeoutMs: 0,
                fallbackStrategy: "ignoreDependentFail",
                expectedExternalDailyRequestCount: 0,
                uniqueEndpointName,
            },
        ];

        // ── 2. TDependOnMapWithCallProbability ────────────────────────────────
        // 無下游依賴

        const dependOnMap: TDependOnMapWithCallProbability = new Map();

        // ── 3. Map<string, TCMetricsPerTimeSlot>（slotCount 個 slot）─────────

        const slotCount = slotRps.length;
        const perSlotCap = Math.max(
            SimulatorRunnerAdapter.MIN_REQUESTS_PER_SLOT,
            Math.floor(SimulatorRunnerAdapter.MAX_REQUESTS_PER_RUN / Math.max(1, slotCount)),
        );

        // capacityPerReplica is req/SECOND. LatencySimulator.computeLoadDriven
        // unconditionally multiplies by 3600 (`capacityPerHour = capacity * 3600`)
        // because the REAL simulator's slot is an hour. Pre-multiplying by (D / 3600)
        // makes that hardcoded 3600 cancel, so rho reduces to the true
        // rps / (capacityPerReplica * replicas) for ANY slot duration D:
        //
        //   rho = (rps·D·s) / (capacityPerReplica·s·(D/3600)·replicas·3600)
        //       = rps / (capacityPerReplica·replicas)                        ✓
        //
        // The request-budget down-scaling folds into the same factor `s`, computed from
        // the REALISED request count so rounding, capping and the max(1, …) floor
        // cannot skew rho.
        const hourFraction = slotDurationSeconds / 3600;

        const metricsPerTimeSlotMap = new Map<string, TCMetricsPerTimeSlot>();
        const slotKeys: string[] = [];

        for (let i = 0; i < slotCount; i++) {
            const rps = slotRps[i] ?? 0;
            const replicaCount = Math.max(1, slotReplicaCount[i] ?? 1);

            // Exact (fractional) demand for this slot, before rounding or capping.
            const exactCount = rps * slotDurationSeconds;
            // Always simulate at least one request when traffic was observed: a slot with
            // zero simulated requests reports p50 = 0 against a non-zero observation,
            // which is a structural 100% MAPE contribution.
            const requestCount = exactCount > 0
                ? Math.min(perSlotCap, Math.max(1, Math.round(exactCount)))
                : 0;
            const scale = exactCount > 0 ? requestCount / exactCount : 1;

            const slot = new TCMetricsPerTimeSlot();
            slot.setEntryPointRequestCount(uniqueEndpointName, requestCount);
            slot.setServiceReplicaCount(uniqueServiceName, replicaCount);
            // Never 0: setServiceCapacityPerReplica clamps at 0, and a literal 0 would make
            // capacityPerHour 0 and rho Infinity → clamped to 0.95 (fake saturation).
            slot.setServiceCapacityPerReplica(
                uniqueServiceName,
                Math.max(1e-9, capacityPerReplica * scale * hourFraction),
            );
            slot.setEndpointDelayMap(new Map([[uniqueEndpointName, delays]]));
            slot.setEndpointErrorRate(uniqueEndpointName, errorRate);
            slot.setEndpointMaxLatency(uniqueEndpointName, 0);
            slot.setEndpointTimeoutMs(uniqueEndpointName, 0);

            // The key is opaque on the calibration path — simulatePropagation only ever
            // uses it as a Map key and iterates in insertion order. It is still emitted in
            // a valid "day-hour-minute" shape so it stays debuggable and wouldn't silently
            // collide if this map were ever routed through LoadSimulationHandler.
            const key = `0-${Math.floor(i / 60)}-${i % 60}`;
            slotKeys.push(key);
            metricsPerTimeSlotMap.set(key, slot);
        }

        // ── 4. 執行模擬 ───────────────────────────────────────────────────────

        const propagationResult = this.propagator.simulatePropagation(
            endpointMetrics,
            dependOnMap,
            metricsPerTimeSlotMap,
            true,
        );

        // ── 5. 萃取每個 slot 的 p50 / errorRate / rps ────────────────────────

        return this.extractResult(propagationResult, uniqueEndpointName, slotKeys, slotRps);
    }

    private extractResult(
        propagationResult: Map<string, Map<string, any>>,
        uniqueEndpointName: string,
        slotKeys: string[],
        slotRps: number[],
    ): SimulatorRunResult {
        const p50BySlot: number[] = [];
        const errorRateBySlot: number[] = [];
        const rpsBySlot: number[] = [];
        const simulatedRequestCountBySlot: number[] = [];
        const simulatedErrorCountBySlot: number[] = [];

        for (let i = 0; i < slotKeys.length; i++) {
            const slotResult = propagationResult.get(slotKeys[i]);
            const epStats = slotResult?.get(uniqueEndpointName);

            if (!epStats || epStats.requestCount === 0) {
                p50BySlot.push(0);
                errorRateBySlot.push(0);
                rpsBySlot.push(0);
                simulatedRequestCountBySlot.push(0);
                simulatedErrorCountBySlot.push(0);
                continue;
            }

            // p50 ← status=200 的 mean latency（Welford mean，最接近 p50 的可用指標）。
            // 若該 slot 所有請求都失敗，latencyStatsByStatus 不會有 "200" 桶 → 0，
            // ConverterService 的 mask 會把這種 slot 排除，而不是拿 0 去比。
            const latencyStats = epStats.latencyStatsByStatus?.get("200");
            p50BySlot.push(latencyStats?.mean ?? 0);

            errorRateBySlot.push(epStats.ownErrorCount / epStats.requestCount);
            simulatedRequestCountBySlot.push(epStats.requestCount);
            simulatedErrorCountBySlot.push(epStats.ownErrorCount);

            // rps ← 直接沿用觀測值。propagator 不會節流 entry point 的請求數
            // （校準路徑繞過 OverloadErrorRateAndLatencyEstimator 與 autoscaling），
            // 所以「模擬 rps」定義上就等於輸入 rps，這一項的 MAPE 因此恆為 0：
            // 它是加在每個候選上的同一個常數，不影響排名，但會系統性地壓低回報的
            // weighted 分數。真正有資訊量的是 simulatedRequestCountBySlot。
            rpsBySlot.push(slotRps[i] ?? 0);
        }

        return {
            p50BySlot,
            errorRateBySlot,
            rpsBySlot,
            simulatedRequestCountBySlot,
            simulatedErrorCountBySlot,
        };
    }
}
