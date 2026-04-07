import MLModelClient, { MLModelType, MLPredictFeatures, MLPredictSequence } from "./MLModelClient";

const SECONDS_PER_HOUR = 3600;
const LSTM_WINDOW_SIZE = 10;

export default class MLScalingHandler {
  private static instance?: MLScalingHandler;
  static getInstance = () => this.instance || (this.instance = new this());

  private mlClient: MLModelClient;

  private constructor() {
    this.mlClient = MLModelClient.getInstance();
  }

  /**
   * 用 ML 模型預測下一個時間步的 requestCountPerSecond
   * service 在訓練時是 1~4 的 category code，預測時傳 0 表示未知/模擬中的 service
   */
  async predictNextRPS(
    model: MLModelType,
    currentFeatures: {
      replicaCount: number;
      requestCountPerSecond: number;
      replicaMaxRPS: number;
    },
    // LSTM 專用：過去 WINDOW_SIZE 個時間步的資料，按時間升序排列
    history?: Array<{
      replicaCount: number;
      requestCountPerSecond: number;
      replicaMaxRPS: number;
    }>
  ): Promise<number | null> {

    if (model === "lstm") {
      return this.predictWithLSTM(history);
    }
    return this.predictWithTabular(model, currentFeatures);
  }

  private async predictWithTabular(
    model: MLModelType,
    features: { replicaCount: number; requestCountPerSecond: number; replicaMaxRPS: number }
  ): Promise<number | null> {
    const payload: MLPredictFeatures = {
      replicaCount: features.replicaCount,
      requestCountPerSecond: features.requestCountPerSecond,
      replicaMaxRPS: features.replicaMaxRPS,
      service: 0,  // 訓練時是 1~4，預測模擬中的 service 時傳 0
    };
    return this.mlClient.predictNextRequestCount(model, payload);
  }

  private async predictWithLSTM(
    history?: Array<{ replicaCount: number; requestCountPerSecond: number; replicaMaxRPS: number }>
  ): Promise<number | null> {
    if (!history || history.length < LSTM_WINDOW_SIZE) {
      // 歷史資料不足，無法使用 LSTM
      return null;
    }

    // 取最近 WINDOW_SIZE 筆，按時間升序
    const sequenceWindow  = history.slice(-LSTM_WINDOW_SIZE);

    const sequence: MLPredictSequence = sequenceWindow.map(step => ({
      replicaCount: step.replicaCount,
      requestCountPerSecond: step.requestCountPerSecond,
      replicaMaxRPS: step.replicaMaxRPS,
      service: 0,
    }));

    return this.mlClient.predictNextRequestCount("lstm", sequence);
  }

  /**
   * 從已排序的 timeSlotKeys 中，取得某個 service 在 currentTimeSlotKey 之前的歷史資料
   * 用於 LSTM 的 sequence 建構
   */
  buildHistoryWindow(
    uniqueServiceName: string,
    currentTimeSlotKey: string,
    sortedTimeSlotKeys: string[],
    serviceReceivedRequestCount: Map<string, Map<string, number>>,
    metricsPerTimeSlotMap: Map<string, any>,  // TCMetricsPerTimeSlot
  ): Array<{ replicaCount: number; requestCountPerSecond: number; replicaMaxRPS: number }> | null {
    const currentIndex = sortedTimeSlotKeys.indexOf(currentTimeSlotKey);
    if (currentIndex < LSTM_WINDOW_SIZE) return null;

    const windowKeys = sortedTimeSlotKeys.slice(
      currentIndex - LSTM_WINDOW_SIZE,
      currentIndex
    );

    return windowKeys.map(key => {
      const counts = serviceReceivedRequestCount.get(key);
      const metrics = metricsPerTimeSlotMap.get(key);
      const requestCountInHour = counts?.get(uniqueServiceName) ?? 0;

      return {
        replicaCount: metrics?.getServiceReplicaCount(uniqueServiceName) ?? 0,
        requestCountPerSecond: requestCountInHour / SECONDS_PER_HOUR,
        replicaMaxRPS: metrics?.getServiceCapacityPerReplica(uniqueServiceName) ?? 0,
      };
    });
  }
}