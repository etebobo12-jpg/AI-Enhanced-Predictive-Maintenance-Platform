// PredictionStorage.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { uintCV, principalCV } from "@stacks/transactions";

const ERR_UNAUTHORIZED = 300;
const ERR_PREDICTION_NOT_FINALIZED = 301;
const ERR_DATA_ID_MISMATCH = 302;
const ERR_INVALID_CONFIDENCE = 303;
const ERR_ROUND_NOT_FOUND = 304;
const ERR_ALREADY_ARCHIVED = 305;

interface FinalizedPrediction {
  "data-id": bigint;
  round: bigint;
  "predicted-failure": boolean;
  confidence: bigint;
  "oracle-count": bigint;
  "finalized-at": bigint;
  archived: boolean;
}

interface Result<T> {
  ok: boolean;
  value: T | number;
}

class PredictionStorageMock {
  state: {
    admin: string;
    finalizedPredictions: Map<bigint, FinalizedPrediction>;
    devicePredictionHistory: Map<string, bigint>;
    latestPredictionByDevice: Map<string, bigint>;
  } = {
    admin: "ST1ADMIN",
    finalizedPredictions: new Map(),
    devicePredictionHistory: new Map(),
    latestPredictionByDevice: new Map(),
  };

  blockHeight: bigint = 2000n;
  contractCaller: string = "ST1ORACLE_INTEGRATOR";

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      admin: "ST1ADMIN",
      finalizedPredictions: new Map(),
      devicePredictionHistory: new Map(),
      latestPredictionByDevice: new Map(),
    };
    this.blockHeight = 2000n;
    this.contractCaller = "ST1ORACLE_INTEGRATOR";
  }

  isAdmin(): boolean {
    return this.contractCaller === this.state.admin;
  }

  getFinalizedPrediction(dataId: bigint): FinalizedPrediction | null {
    return this.state.finalizedPredictions.get(dataId) || null;
  }

  getPredictionForDevice(device: string, dataId: bigint): bigint | null {
    return (
      this.state.devicePredictionHistory.get(`${device}-${dataId}`) || null
    );
  }

  getLatestPredictionId(device: string): bigint {
    return this.state.latestPredictionByDevice.get(device) || 0n;
  }

  isPredictionArchived(dataId: bigint): boolean {
    const pred = this.state.finalizedPredictions.get(dataId);
    return pred?.archived || false;
  }

  archivePrediction(
    dataId: bigint,
    round: bigint,
    predictedFailure: boolean,
    confidence: bigint,
    oracleCount: bigint
  ): Result<boolean> {
    if (this.state.finalizedPredictions.has(dataId)) {
      return { ok: false, value: ERR_ALREADY_ARCHIVED };
    }
    if (confidence > 100n) {
      return { ok: false, value: ERR_INVALID_CONFIDENCE };
    }
    if (oracleCount === 0n) {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }

    this.state.finalizedPredictions.set(dataId, {
      "data-id": dataId,
      round,
      "predicted-failure": predictedFailure,
      confidence,
      "oracle-count": oracleCount,
      "finalized-at": this.blockHeight,
      archived: true,
    });
    return { ok: true, value: true };
  }

  storeFinalizedPrediction(
    dataId: bigint,
    deviceId: string,
    round: bigint,
    predictedFailure: boolean,
    confidence: bigint,
    oracleCount: bigint
  ): Result<bigint> {
    if (this.contractCaller !== "ST1ORACLE_INTEGRATOR") {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }
    if (this.state.finalizedPredictions.has(dataId)) {
      return { ok: false, value: ERR_ALREADY_ARCHIVED };
    }

    this.state.finalizedPredictions.set(dataId, {
      "data-id": dataId,
      round,
      "predicted-failure": predictedFailure,
      confidence,
      "oracle-count": oracleCount,
      "finalized-at": this.blockHeight,
      archived: false,
    });

    const historyKey = `${deviceId}-${dataId}`;
    this.state.devicePredictionHistory.set(historyKey, dataId);
    this.state.latestPredictionByDevice.set(deviceId, dataId);

    return { ok: true, value: dataId };
  }

  markPredictionArchived(dataId: bigint): Result<boolean> {
    const pred = this.state.finalizedPredictions.get(dataId);
    if (!pred) {
      return { ok: false, value: ERR_ROUND_NOT_FOUND };
    }
    if (!this.isAdmin()) {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }
    this.state.finalizedPredictions.set(dataId, { ...pred, archived: true });
    return { ok: true, value: true };
  }

  transferAdmin(newAdmin: string): Result<boolean> {
    if (!this.isAdmin()) {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }
    this.state.admin = newAdmin;
    return { ok: true, value: true };
  }

  getPredictionSummary(dataId: bigint): {
    "predicted-failure": boolean;
    confidence: bigint;
    "oracle-count": bigint;
    archived: boolean;
  } | null {
    const pred = this.state.finalizedPredictions.get(dataId);
    if (!pred) return null;
    return {
      "predicted-failure": pred["predicted-failure"],
      confidence: pred.confidence,
      "oracle-count": pred["oracle-count"],
      archived: pred.archived,
    };
  }

  getDevicePredictionTimeline(device: string): Array<{
    "data-id": bigint;
    failure: boolean;
    confidence: bigint;
    timestamp: bigint;
  }> {
    const latestId = this.state.latestPredictionByDevice.get(device) || 0n;
    const pred = this.state.finalizedPredictions.get(latestId);
    if (!pred) return [];
    return [
      {
        "data-id": latestId,
        failure: pred["predicted-failure"],
        confidence: pred.confidence,
        timestamp: pred["finalized-at"],
      },
    ];
  }
}

describe("PredictionStorage", () => {
  let contract: PredictionStorageMock;

  beforeEach(() => {
    contract = new PredictionStorageMock();
    contract.reset();
  });

  it("stores finalized prediction from OracleIntegrator", () => {
    const result = contract.storeFinalizedPrediction(
      100n,
      "ST1DEVICE",
      1n,
      true,
      92n,
      5n
    );
    expect(result.ok).toBe(true);
    expect(result.value).toBe(100n);

    const pred = contract.getFinalizedPrediction(100n);
    expect(pred?.["predicted-failure"]).toBe(true);
    expect(pred?.confidence).toBe(92n);
    expect(pred?.["oracle-count"]).toBe(5n);
    expect(pred?.archived).toBe(false);
  });

  it("rejects store from unauthorized caller", () => {
    contract.contractCaller = "ST1HACKER";
    const result = contract.storeFinalizedPrediction(
      101n,
      "ST1DEVICE",
      1n,
      true,
      90n,
      3n
    );
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_UNAUTHORIZED);
  });

  it("prevents duplicate storage of same data-id", () => {
    contract.storeFinalizedPrediction(102n, "ST1DEVICE", 1n, true, 88n, 4n);
    const result = contract.storeFinalizedPrediction(
      102n,
      "ST1DEVICE",
      2n,
      false,
      75n,
      3n
    );
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ALREADY_ARCHIVED);
  });

  it("links prediction to device history", () => {
    contract.storeFinalizedPrediction(103n, "ST1SENSOR", 1n, false, 95n, 7n);
    const history = contract.getPredictionForDevice("ST1SENSOR", 103n);
    expect(history).toBe(103n);

    const latest = contract.getLatestPredictionId("ST1SENSOR");
    expect(latest).toBe(103n);
  });

  it("admin can mark prediction as archived", () => {
    contract.storeFinalizedPrediction(104n, "ST1DEVICE", 1n, true, 80n, 3n);
    contract.contractCaller = "ST1ADMIN";
    const result = contract.markPredictionArchived(104n);
    expect(result.ok).toBe(true);
    expect(contract.isPredictionArchived(104n)).toBe(true);
  });

  it("non-admin cannot archive", () => {
    contract.storeFinalizedPrediction(105n, "ST1DEVICE", 1n, true, 70n, 3n);
    contract.contractCaller = "ST1USER";
    const result = contract.markPredictionArchived(105n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_UNAUTHORIZED);
  });

  it("returns correct prediction summary", () => {
    contract.storeFinalizedPrediction(106n, "ST1DEVICE", 1n, true, 85n, 5n);
    const summary = contract.getPredictionSummary(106n);
    expect(summary?.["predicted-failure"]).toBe(true);
    expect(summary?.confidence).toBe(85n);
    expect(summary?.archived).toBe(false);
  });

  it("returns device prediction timeline", () => {
    contract.storeFinalizedPrediction(107n, "ST1MACHINE", 1n, false, 78n, 4n);
    const timeline = contract.getDevicePredictionTimeline("ST1MACHINE");
    expect(timeline.length).toBe(1);
    expect(timeline[0].failure).toBe(false);
    expect(timeline[0].confidence).toBe(78n);
  });

  it("allows admin transfer", () => {
    contract.contractCaller = "ST1ADMIN";
    const result = contract.transferAdmin("ST2NEWADMIN");
    expect(result.ok).toBe(true);
    expect(contract.state.admin).toBe("ST2NEWADMIN");
  });

  it("rejects invalid confidence", () => {
    const result = contract.archivePrediction(108n, 1n, true, 150n, 3n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_CONFIDENCE);
  });

  it("archive function works independently", () => {
    const result = contract.archivePrediction(109n, 1n, true, 88n, 3n);
    expect(result.ok).toBe(true);
    const pred = contract.getFinalizedPrediction(109n);
    expect(pred?.archived).toBe(true);
  });
});
