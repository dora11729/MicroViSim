/**
 * SimulatorRunnerAdapter.ts
 *
 * Adapts LoadSimulationPropagator to the ISimulatorRunner interface
 * required by ConverterService.
 *
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

    // Grid search 期間每個 slot 最多模擬的 request 數。
    // 縮放不影響成功/失敗比例（error injection 是逐請求機率抽樣，子取樣不改變期望比例），
    // 但會影響 loadDriven 的使用率（rho = requestCount / capacityPerHour）——
    // 因此 capacity 必須用同一個縮放係數同步縮小，見下方迴圈。
    private static readonly MAX_REQUESTS_PER_SLOT = 100;

    runEndpoint(params: SimulatorRunParams): SimulatorRunResult {
        const {
            service,
            endpoint,
            delays,
            capacityPerReplica,
            hourlyRps,
            replicaCount,
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

        // ── 3. Map<string, TCMetricsPerTimeSlot>（24 個 hourly slot）─────────

        const metricsPerTimeSlotMap = new Map<string, TCMetricsPerTimeSlot>();

        for (let hour = 0; hour < 24; hour++) {
            const rps = hourlyRps[hour] ?? 0;
            const rawCount = Math.round(rps * 3600);

            // 請求量與「用來算 loadDriven rho 的 capacity」套用同一個縮放係數，
            // 讓 rho = scaledCount / (scaledCapacity*3600) 維持跟真實比例一致，
            // 同時仍把模擬用的絕對請求量壓在 MAX_REQUESTS_PER_SLOT 以內。
            const scale = rawCount > SimulatorRunnerAdapter.MAX_REQUESTS_PER_SLOT
                ? SimulatorRunnerAdapter.MAX_REQUESTS_PER_SLOT / rawCount
                : 1;
            const scaled = rawCount === 0
                ? 0
                : Math.max(1, Math.round(rawCount * scale));

            const slot = new TCMetricsPerTimeSlot();
            slot.setEntryPointRequestCount(uniqueEndpointName, scaled);
            slot.setServiceReplicaCount(uniqueServiceName, replicaCount);
            // 只縮放這一小時內部用來算 rho 的 capacity；不會外洩到 ConverterService
            // 的 grid search（那邊搜尋、回報的一直是真實、未縮放的 capacityPerReplica）。
            slot.setServiceCapacityPerReplica(uniqueServiceName, capacityPerReplica * scale);
            slot.setEndpointDelayMap(new Map([[uniqueEndpointName, delays]]));
            slot.setEndpointErrorRate(uniqueEndpointName, errorRate);
            slot.setEndpointMaxLatency(uniqueEndpointName, 0);
            slot.setEndpointTimeoutMs(uniqueEndpointName, 0);

            // timeSlotKey 格式："day-hour-minute"，校準固定用 day=0, minute=0
            metricsPerTimeSlotMap.set(`0-${hour}-0`, slot);
        }

        // ── 4. 執行模擬 ───────────────────────────────────────────────────────

        const propagationResult = this.propagator.simulatePropagation(
            endpointMetrics,
            dependOnMap,
            metricsPerTimeSlotMap,
            true,
        );

        // ── 5. 萃取每小時 p50 / errorRate / rps ──────────────────────────────

        return this.extractResult(propagationResult, uniqueEndpointName, hourlyRps);
    }

    private extractResult(
        propagationResult: Map<string, Map<string, any>>,
        uniqueEndpointName: string,
        hourlyRps: number[],
    ): SimulatorRunResult {
        const p50ByHour: number[] = [];
        const errorRateByHour: number[] = [];
        const rpsByHour: number[] = [];

        for (let hour = 0; hour < 24; hour++) {
            const slotResult = propagationResult.get(`0-${hour}-0`);
            const epStats = slotResult?.get(uniqueEndpointName);

            if (!epStats || epStats.requestCount === 0) {
                p50ByHour.push(0);
                errorRateByHour.push(0);
                rpsByHour.push(0);
                continue;
            }

            // p50 ← status=200 的 mean latency（Welford mean，最接近 p50 的可用指標）
            const latencyStats = epStats.latencyStatsByStatus?.get("200");
            p50ByHour.push(latencyStats?.mean ?? 0);

            // errorRate ← ownErrorCount / requestCount
            errorRateByHour.push(epStats.ownErrorCount / epStats.requestCount);

            // rps ← 直接沿用觀測值（propagator 不改變 entry point RPS）
            rpsByHour.push(hourlyRps[hour] ?? 0);
        }

        return { p50ByHour, errorRateByHour, rpsByHour };
    }
}