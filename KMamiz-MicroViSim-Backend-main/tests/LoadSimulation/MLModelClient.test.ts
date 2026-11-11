import axios, { AxiosError, CanceledError } from "axios";
import MLModelClient, { TMLTrainingService } from "../../src/MicroViSim-simulator/classes/LoadSimulation/MLModelClient";
import {
  NoProgress,
  SimulationCancelledError,
  SimulationFailedError,
} from "../../src/MicroViSim-simulator/entities/TSimulationProgress";

const client = MLModelClient.getInstance();
const Services: TMLTrainingService[] = [{ service: "order\tdefault\tv1", model: "gru", dailyRequestCount: 1000 }];

describe("MLModelClient.train", () => {
  afterEach(() => jest.restoreAllMocks());

  it("stops the ML service's training when the run is cancelled", async () => {
    const post = jest.spyOn(axios, "post").mockImplementation((url: string, _body?: unknown, config?: any) =>
      url.endsWith("/train")
        ? new Promise((_, reject) => config.signal.addEventListener("abort", () => reject(new CanceledError())))
        : Promise.resolve({ data: { cancelled: true } })
    );
    const controller = new AbortController();
    const training = client.train(Services, { ...NoProgress, signal: controller.signal });

    controller.abort();
    await expect(training).rejects.toBeInstanceOf(SimulationCancelledError);
    expect(post).toHaveBeenCalledWith(expect.stringMatching(/\/train\/cancel$/));
  });

  it("passes on the ML service's reason for a failed run", async () => {
    const response = { status: 500, data: { detail: "Training failed for {'order': 'boom'}" } };
    jest.spyOn(axios, "post").mockRejectedValue(
      new AxiosError("Request failed", "ERR_BAD_RESPONSE", undefined, undefined, response as any)
    );
    const training = client.train(Services);

    await expect(training).rejects.toBeInstanceOf(SimulationFailedError);
    await expect(training).rejects.toThrow("Model training failed: HTTP 500: Training failed for {'order': 'boom'}");
  });

  it("says when the ML service cannot be reached", async () => {
    jest.spyOn(axios, "post").mockRejectedValue(new AxiosError("connect ECONNREFUSED", "ECONNREFUSED"));
    await expect(client.train(Services)).rejects.toThrow(/cannot reach the ML service at .* \(ECONNREFUSED\)/);
  });
});
