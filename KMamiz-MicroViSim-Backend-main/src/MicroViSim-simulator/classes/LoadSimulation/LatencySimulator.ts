import { TSimulationEndpointDelay } from "../../entities/TSimConfigLoadSimulation";

export default class LatencySimulator {
    // AR(1) 狀態：記錄每個 endpoint 的上一個 epsilon
    private epsilonState = new Map<string, number>();
    // Spike 狀態：記錄每個 endpoint 目前的突刺剩餘 slot 數
    private spikeState = new Map<string, number>();

    // private preRequestCountMap = new Map<string, number>(); // 上一個 slot 的 request count，用於 Gradual Drift 計算

    /**
     * 將 latencyMs (ms) 和 jitterMs (ms) 轉換成 LogNormal 參數
     * latencyMs 是目標平均值，jitterMs 是目標標準差
     */
    private toLogNormalParams(mean: number, std: number): { mu: number; sigma: number } {
        // 從實際的 mean/std 反推 LogNormal 的 mu/sigma
        const sigma2 = Math.log(1 + (std / mean) ** 2);
        const mu = Math.log(mean) - sigma2 / 2;
        return { mu, sigma: Math.sqrt(sigma2) };
    }

    /*
    Use AR(1) process to smooth the random noise (epsilon) for more realistic latency simulation.
     */
    private applyAR1(endpointName: string, epsilon: number, phi = 0.7): number {
        const prev = this.epsilonState.get(endpointName) ?? 0;
        const next = phi * prev + epsilon * Math.sqrt(1 - phi ** 2);
        this.epsilonState.set(endpointName, next);
        return next;
    }

    /*
    private getPrevRequestCount(uniqueEndpointName: string, newRequestCount: number): number {
        const prevCount = this.preRequestCountMap.get(uniqueEndpointName) ?? 0;
        this.preRequestCountMap.set(uniqueEndpointName, newRequestCount);
        return prevCount;
    }*/

    /**
     * 主入口：根據 delay 設定和當前 requestCount 計算這次請求的 latency
     */
    computeLatency(
        endpointName: string,
        delays: TSimulationEndpointDelay[],
        maxLatencyMs: number,
        requestCount: number,
        capacity: number
    ): number {
        let total = 0;

        for (const delay of delays) {
            switch (delay.type) {
                case "stable":
                    total += this.computeStable(endpointName, delay.latencyMs, delay.jitterMs);
                    break;
                case "jitter":
                    total += this.computeStable(endpointName, delay.latencyMs, delay.jitterMs * 3);
                    break;
                case "spike":
                    total += this.computeSpike(endpointName, delay, total);
                    break;
                case "gradualDrift":
                    total += this.computeGradualDrift(endpointName, delay);
                    break;
                case "loadDriven":
                    total += this.computeLoadDriven(endpointName, delay, requestCount, capacity);
                    break;
            }
        }

        return maxLatencyMs > 0 ? Math.min(total, maxLatencyMs) : total;
    }

    private computeStable(
        endpointName: string, 
        mean: number, 
        std: number,
        isSmoothed: boolean = true
    ): number {
        if (mean <= 0) return 0;
        const { mu, sigma } = this.toLogNormalParams(mean, Math.max(std, 1));
        // 取樣一個標準常態 epsilon，再套 AR(1)
        const rawEpsilon = (Math.sqrt(-2 * Math.log(Math.random())) *
            Math.cos(2 * Math.PI * Math.random()));

        if (!isSmoothed) {
            return Math.max(0, Math.exp(mu + sigma * rawEpsilon));
        }
        const smoothedEpsilon = this.applyAR1(endpointName, rawEpsilon);
        return Math.max(0, Math.exp(mu + sigma * smoothedEpsilon));
    }

    private computeSpike(
        endpointName: string,
        delay: TSimulationEndpointDelay, 
        baseLatency: number = 0
    ): number {
        if (delay.type !== "spike") return 0;
        const { latencyMs, jitterMs, spikeProbability, spikeMagnitude, spikeDuration } = delay;

        // 檢查是否在突刺中
        const remainingSlots = this.spikeState.get(endpointName) ?? 0;
        const effectiveBase = latencyMs > 0 ? latencyMs : baseLatency;

        if (remainingSlots > 0) {
            // 突刺持續中
            this.spikeState.set(endpointName, remainingSlots - 1);
            return this.computeStable(endpointName, effectiveBase * spikeMagnitude, jitterMs);
        }

        // 以機率觸發新突刺
        if (Math.random() < spikeProbability) {
            this.spikeState.set(endpointName, spikeDuration - 1);
            return this.computeStable(endpointName, effectiveBase * spikeMagnitude, jitterMs * spikeMagnitude);
        }

        return this.computeStable(endpointName, latencyMs, jitterMs);
    }

    /*
    private computeGradualDrift(
      endpointName: string,
      delay: TSimulationEndpointDelay,
      currentRequestCount: number,
    ): number {
      const { latencyMs, jitterMs, driftRate, maxLatencyMs } = delay;
  
      // 負載驅動：request 增量 × driftRate = 額外延遲
      const prevRequestCount = this.getPrevRequestCount(endpointName, currentRequestCount);
      const requestDelta = Math.max(0, currentRequestCount - prevRequestCount);
      const driftedLatency = latencyMs + requestDelta * driftRate;
  
      // 套用上限
      const cappedLatency = maxLatencyMs > 0
        ? Math.min(driftedLatency, maxLatencyMs)
        : driftedLatency;
  
      return this.computeStable(endpointName, cappedLatency, jitterMs);
    }
      */

    private driftAccumulator = new Map<string, number>();

    resetDrift(): void {
        this.driftAccumulator.clear();
    }

    advanceDrift(endpointName: string, driftRate: number): void {
        const prev = this.driftAccumulator.get(endpointName) ?? 0;
        const next = prev + driftRate;
        this.driftAccumulator.set(endpointName, next);
    }

    private computeGradualDrift(
        endpointName: string,
        delay: TSimulationEndpointDelay,
    ): number {
        if (delay.type !== "gradualDrift") return 0;
        const { latencyMs, jitterMs } = delay;

        const accumulated = this.driftAccumulator.get(endpointName) ?? 0;

        const driftedLatency = latencyMs + accumulated;

        return this.computeStable(endpointName, driftedLatency, jitterMs, false);
    }

    private computeLoadDriven(
        endpointName: string,
        delay: TSimulationEndpointDelay,
        requestCount: number,
        capacity: number,
    ): number {
        const { latencyMs, jitterMs } = delay;

        // 使用率 ρ = 當前 request 數 / 服務容量
        const capacityPerHour = capacity * 3600;
        const rho = Math.min(requestCount / capacityPerHour, 0.95); // 夾住避免無限大

        // M/M/1 排隊理論：負載放大係數
        const loadFactor = 1 / (1 - rho);

        const driftedLatency = latencyMs * loadFactor;
        return this.computeStable(endpointName, driftedLatency, jitterMs);
    }
}