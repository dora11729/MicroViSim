/**
 * HTTP handler for the Auto-Converter pipeline.
 * Follows the IRequestHandler pattern used throughout the project.
 *
 * Routes:
 *   POST /converter/run
 *     - Accepts a standard MicroViSim CSV + converter options
 *     - Returns ConverterResult (converted params + MAPE scores)
 *
 *   POST /converter/convert-k6
 *     - Accepts a raw k6 --out csv + nameMap config
 *     - Returns the converted standard CSV string
 *
 */

import { Request, Response } from "express";
import multer from "multer";
import IRequestHandler from "../../../entities/TRequestHandler";
import { MetricsExtractor } from "./MetricsExtractor";
import { ParameterDeriver } from "./ParameterDeriver";
import { ConverterService, ConverterServiceOptions } from "./ConverterService";
import { SimulatorRunnerAdapter } from "./SimulatorRunnerAdapter";
import { K6CsvConverter, K6ServiceEndpointConfig } from "./K6CsvConverter";
import { ParameterDeriverOptions } from "../../entities/TSimConfigConverter";

// multer: store uploaded CSV in memory (same pattern as upload endpoint)
const upload = multer({ storage: multer.memoryStorage() });

export default class ConverterHandler extends IRequestHandler {
  constructor() {
    super("converter");
    this.addRoute("post", "/run", this.handleRun.bind(this), [upload.single("csv")]);
    this.addRoute("post", "/convert-k6", this.handleConvertK6.bind(this), [upload.single("csv")]);
  }

  // ── POST /converter/run ─────────────────────────────────────────────────
  //
  // Body (multipart/form-data):
  //   csv          - MicroViSim standard CSV file
  //   options      - JSON string of ConverterRunOptions (optional)
  //
  // Response: ConverterResult (JSON)

  private handleRun(req: Request, res: Response): void {
    try {
      const csvText = this.extractCsvText(req, res);
      if (csvText === null) return;

      const options = this.parseOptions<ConverterRunOptions>(req.body.options);

      // Same threshold feeds both layers: Layer 1 actually applies it to the baseline
      // computation, Layer 2's diagnostics.lowLoadThresholdPct just echoes it back —
      // they must not be allowed to drift apart.
      const lowLoadThresholdPct = options.lowLoadThresholdPct ?? 0.5;

      // Layer 1 — slot duration is derived from the CSV's own sampling interval unless
      // explicitly overridden; there is deliberately no "slotsPerHour" knob, since a
      // value contradicting the actual bucketing would silently corrupt the drift units.
      const metrics = new MetricsExtractor().extract(
        csvText,
        lowLoadThresholdPct,
        options.slotDurationSeconds,
      );

      // Layer 2
      const deriverOptions: ParameterDeriverOptions = {
        fanOutFactors: options.fanOutFactors ?? {},
        driftDetectionThresholdMs: options.driftDetectionThresholdMs ?? 2.0,
        lowLoadThresholdPct,
      };
      const derived = new ParameterDeriver(deriverOptions).derive(metrics);

      // Layer 3
      const serviceOptions: ConverterServiceOptions = {
        searchRangePct: options.searchRangePct ?? 0.3,
        searchSteps: options.searchSteps ?? 7,
        mapeWeights: options.mapeWeights,
        spikeRatioThreshold: options.spikeRatioThreshold ?? 3.0,
        loadCorrelationThreshold: options.loadCorrelationThreshold ?? 0.6,
        mapeSamplesPerCandidate: options.mapeSamplesPerCandidate ?? 3,
      };
      const result = new ConverterService(
        new SimulatorRunnerAdapter(),
        serviceOptions,
      ).convert(metrics, derived);

      // Map is not JSON-serializable; convert to object
      res.status(200).json({
        summary: result.summary,
        convertedEndpoints: Object.fromEntries(
          Array.from(result.convertedEndpoints.entries()).map(([k, v]) => [
            k,
            {
              ...v,
              // Remove diagnostics from response to keep payload lean
              // (keep if needed for frontend display)
            },
          ])
        ),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  }

  // ── POST /converter/convert-k6 ─────────────────────────────────────────
  //
  // Body (multipart/form-data):
  //   csv      - k6 raw CSV file (--out csv)
  //   config   - JSON string of K6ServiceEndpointConfig
  //
  // Response: { csv: string } — MicroViSim standard CSV

  private handleConvertK6(req: Request, res: Response): void {
    try {
      const csvText = this.extractCsvText(req, res);
      if (csvText === null) return;

      const config = this.parseOptions<K6ServiceEndpointConfig>(req.body.config);
      if (!config.nameMap) {
        res.status(400).json({ error: "config.nameMap is required for k6 conversion." });
        return;
      }

      const fullConfig: K6ServiceEndpointConfig = {
        nameMap: config.nameMap,
        replicaCounts: config.replicaCounts,
      };
      const standardCsv = new K6CsvConverter().convert(csvText, fullConfig);
      res.status(200).json({ csv: standardCsv });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private extractCsvText(req: Request, res: Response): string | null {
    if (req.file?.buffer) {
      return req.file.buffer.toString("utf-8");
    }
    if (typeof req.body?.csv === "string") {
      return req.body.csv;
    }
    res.status(400).json({ error: "No CSV provided. Send as multipart file field 'csv' or body field 'csv'." });
    return null;
  }

  private parseOptions<T>(raw: unknown): Partial<T> {
    if (!raw) return {};
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as Partial<T>;
      } catch {
        return {};
      }
    }
    return raw as Partial<T>;
  }
}

// ─── Request option types (for documentation / frontend contract) ─────────────

interface ConverterRunOptions {
  // MetricsExtractor options
  /** Force a bucket size instead of deriving one from the CSV's sampling interval. */
  slotDurationSeconds?: number;

  // ParameterDeriver options
  fanOutFactors?: Record<string, number>;
  driftDetectionThresholdMs?: number;
  lowLoadThresholdPct?: number;

  // ConverterService options
  searchRangePct?: number;
  searchSteps?: number;
  mapeWeights?: { latency: number; errorRate: number; rps: number };
  spikeRatioThreshold?: number;
  loadCorrelationThreshold?: number;
  mapeSamplesPerCandidate?: number;
}