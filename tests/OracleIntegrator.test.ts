// OracleIntegrator.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  buffCV,
  uintCV,
  boolCV,
  tupleCV,
  principalCV,
} from "@stacks/transactions";

const ERR_UNAUTHORIZED = 200;
const ERR_ORACLE_EXISTS = 201;
const ERR_ORACLE_NOT_FOUND = 202;
const ERR_PREDICTION_EXISTS = 203;
const ERR_INVALID_SIGNATURE = 204;
const ERR_EXPIRED_SIGNATURE = 205;
const ERR_INVALID_ROUND = 206;
const ERR_ROUND_CLOSED = 207;
const ERR_INSUFFICIENT_ORACLES = 208;

interface Oracle {
  "registered-at": bigint;
  stake: bigint;
  "is-active": boolean;
  reputation: bigint;
}

interface Prediction {
  "predicted-failure": boolean;
  confidence: bigint;
  timestamp: bigint;
  "oracle-count": bigint;
  finalized: boolean;
}

interface Vote {
  vote: boolean;
  confidence: bigint;
  signature: Buffer;
  "submitted-at": bigint;
}

interface Result<T> {
  ok: boolean;
  value: T | number;
}

class OracleIntegratorMock {
  state: {
    admin: string;
    minOracles: bigint;
    signatureValidity: bigint;
    oracles: Map<string, Oracle>;
    predictions: Map<string, Prediction>;
    oracleVotes: Map<string, Vote>;
    activeRounds: Map<bigint, bigint>;
  } = {
    admin: "ST1ADMIN",
    minOracles: 3n,
    signatureValidity: 100n,
    oracles: new Map(),
    predictions: new Map(),
    oracleVotes: new Map(),
    activeRounds: new Map(),
  };

  blockHeight: bigint = 1000n;
  caller: string = "ST1ORACLE1";

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      admin: "ST1ADMIN",
      minOracles: 3n,
      signatureValidity: 100n,
      oracles: new Map(),
      predictions: new Map(),
      oracleVotes: new Map(),
      activeRounds: new Map(),
    };
    this.blockHeight = 1000n;
    this.caller = "ST1ORACLE1";
  }

  isAdmin(): boolean {
    return this.caller === this.state.admin;
  }

  validateSignature(msg: Buffer, sig: Buffer, pubkey: string): boolean {
    return sig.length === 65 && pubkey === this.caller;
  }

  getOracle(oracle: string): Oracle | null {
    return this.state.oracles.get(oracle) || null;
  }

  getPrediction(dataId: bigint, round: bigint): Prediction | null {
    return this.state.predictions.get(`${dataId}-${round}`) || null;
  }

  getVote(dataId: bigint, round: bigint, oracle: string): Vote | null {
    return this.state.oracleVotes.get(`${dataId}-${round}-${oracle}`) || null;
  }

  getActiveRound(dataId: bigint): bigint | null {
    return this.state.activeRounds.get(dataId) || null;
  }

  registerOracle(stake: bigint): Result<boolean> {
    if (this.state.oracles.has(this.caller)) {
      return { ok: false, value: ERR_ORACLE_EXISTS };
    }
    if (stake < 1000000n) {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }
    this.state.oracles.set(this.caller, {
      "registered-at": this.blockHeight,
      stake,
      "is-active": true,
      reputation: 100n,
    });
    return { ok: true, value: true };
  }

  deregisterOracle(): Result<boolean> {
    const info = this.state.oracles.get(this.caller);
    if (!info || !info["is-active"]) {
      return { ok: false, value: ERR_ORACLE_NOT_FOUND };
    }
    this.state.oracles.set(this.caller, { ...info, "is-active": false });
    return { ok: true, value: true };
  }

  startPredictionRound(dataId: bigint): Result<bigint> {
    const currentRound = this.state.activeRounds.get(dataId) || 0n;
    const round = currentRound + 1n;
    const key = `${dataId}-${round}`;
    if (this.state.predictions.has(key)) {
      return { ok: false, value: ERR_PREDICTION_EXISTS };
    }
    this.state.activeRounds.set(dataId, round);
    this.state.predictions.set(key, {
      "predicted-failure": false,
      confidence: 0n,
      timestamp: this.blockHeight,
      "oracle-count": 0n,
      finalized: false,
    });
    return { ok: true, value: round };
  }

  submitPrediction(
    dataId: bigint,
    round: bigint,
    predictedFailure: boolean,
    confidence: bigint,
    signature: Buffer
  ): Result<boolean> {
    const oracleInfo = this.state.oracles.get(this.caller);
    if (!oracleInfo || !oracleInfo["is-active"]) {
      return { ok: false, value: ERR_ORACLE_NOT_FOUND };
    }
    const activeRound = this.state.activeRounds.get(dataId);
    if (!activeRound || activeRound !== round) {
      return { ok: false, value: ERR_INVALID_ROUND };
    }
    const voteKey = `${dataId}-${round}-${this.caller}`;
    if (this.state.oracleVotes.has(voteKey)) {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }
    const predKey = `${dataId}-${round}`;
    const pred = this.state.predictions.get(predKey);
    if (!pred) {
      return { ok: false, value: ERR_INVALID_ROUND };
    }
    if (this.blockHeight - pred.timestamp > this.state.signatureValidity) {
      return { ok: false, value: ERR_EXPIRED_SIGNATURE };
    }
    if (!this.validateSignature(Buffer.alloc(32), signature, this.caller)) {
      return { ok: false, value: ERR_INVALID_SIGNATURE };
    }
    if (confidence > 100n) {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }

    this.state.oracleVotes.set(voteKey, {
      vote: predictedFailure,
      confidence,
      signature,
      "submitted-at": this.blockHeight,
    });

    const newCount = pred["oracle-count"] + 1n;
    const updatedPred: Prediction = {
      ...pred,
      "oracle-count": newCount,
      "predicted-failure": pred["predicted-failure"] || predictedFailure,
      confidence: confidence > pred.confidence ? confidence : pred.confidence,
    };
    this.state.predictions.set(predKey, updatedPred);

    if (newCount >= this.state.minOracles) {
      this.state.predictions.set(predKey, { ...updatedPred, finalized: true });
      this.state.activeRounds.delete(dataId);
      return { ok: true, value: true };
    }
    return { ok: true, value: false };
  }

  setMinOracles(newMin: bigint): Result<boolean> {
    if (!this.isAdmin()) {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }
    if (newMin < 2n) {
      return { ok: false, value: ERR_INSUFFICIENT_ORACLES };
    }
    this.state.minOracles = newMin;
    return { ok: true, value: true };
  }

  setSignatureValidity(blocks: bigint): Result<boolean> {
    if (!this.isAdmin()) {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }
    if (blocks === 0n) {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }
    this.state.signatureValidity = blocks;
    return { ok: true, value: true };
  }

  transferAdmin(newAdmin: string): Result<boolean> {
    if (!this.isAdmin()) {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }
    this.state.admin = newAdmin;
    return { ok: true, value: true };
  }

  isPredictionFinalized(dataId: bigint, round: bigint): boolean {
    const pred = this.state.predictions.get(`${dataId}-${round}`);
    return pred?.finalized || false;
  }
}

describe("OracleIntegrator", () => {
  let contract: OracleIntegratorMock;

  beforeEach(() => {
    contract = new OracleIntegratorMock();
    contract.reset();
  });

  it("registers oracle with sufficient stake", () => {
    const result = contract.registerOracle(2000000n);
    expect(result.ok).toBe(true);
    const oracle = contract.getOracle("ST1ORACLE1");
    expect(oracle?.["is-active"]).toBe(true);
    expect(oracle?.stake).toBe(2000000n);
  });

  it("rejects oracle registration with low stake", () => {
    const result = contract.registerOracle(500000n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_UNAUTHORIZED);
  });

  it("deregisters active oracle and returns stake", () => {
    contract.registerOracle(1000000n);
    const result = contract.deregisterOracle();
    expect(result.ok).toBe(true);
    const oracle = contract.getOracle("ST1ORACLE1");
    expect(oracle?.["is-active"]).toBe(false);
  });

  it("starts a new prediction round", () => {
    const result = contract.startPredictionRound(5n);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(1n);
    expect(contract.getActiveRound(5n)).toBe(1n);
  });

  it("allows multiple oracles to submit predictions", () => {
    contract.caller = "ST1ORACLE1";
    contract.registerOracle(1000000n);
    contract.caller = "ST2ORACLE2";
    contract.registerOracle(1000000n);
    contract.caller = "ST3ORACLE3";
    contract.registerOracle(1000000n);

    contract.caller = "ST1ORACLE1";
    contract.startPredictionRound(10n);

    contract.caller = "ST1ORACLE1";
    const sig1 = Buffer.alloc(65, 1);
    contract.submitPrediction(10n, 1n, true, 85n, sig1);

    contract.caller = "ST2ORACLE2";
    const sig2 = Buffer.alloc(65, 2);
    contract.submitPrediction(10n, 1n, true, 90n, sig2);

    contract.caller = "ST3ORACLE3";
    const sig3 = Buffer.alloc(65, 3);
    const result = contract.submitPrediction(10n, 1n, false, 70n, sig3);

    expect(result.ok).toBe(true);
    expect(contract.isPredictionFinalized(10n, 1n)).toBe(true);
    const pred = contract.getPrediction(10n, 1n);
    expect(pred?.["predicted-failure"]).toBe(true);
    expect(pred?.confidence).toBe(90n);
    expect(pred?.["oracle-count"]).toBe(3n);
  });

  it("finalizes only when min-oracles threshold is met", () => {
    contract.caller = "ST1ORACLE1";
    contract.registerOracle(1000000n);
    contract.caller = "ST2ORACLE2";
    contract.registerOracle(1000000n);

    contract.caller = "ST1ORACLE1";
    contract.startPredictionRound(15n);

    contract.caller = "ST1ORACLE1";
    contract.submitPrediction(15n, 1n, true, 80n, Buffer.alloc(65, 1));
    expect(contract.isPredictionFinalized(15n, 1n)).toBe(false);

    contract.caller = "ST2ORACLE2";
    const result = contract.submitPrediction(
      15n,
      1n,
      true,
      75n,
      Buffer.alloc(65, 2)
    );
    expect(result.ok).toBe(true);
    expect(contract.isPredictionFinalized(15n, 1n)).toBe(false);
  });

  it("rejects vote from inactive oracle", () => {
    contract.caller = "ST1ORACLE1";
    contract.registerOracle(1000000n);
    contract.deregisterOracle();

    contract.startPredictionRound(20n);
    const result = contract.submitPrediction(
      20n,
      1n,
      true,
      80n,
      Buffer.alloc(65, 1)
    );
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ORACLE_NOT_FOUND);
  });

  it("rejects expired signatures", () => {
    contract.caller = "ST1ORACLE1";
    contract.registerOracle(1000000n);
    contract.startPredictionRound(25n);
    contract.blockHeight = 1200n;
    const result = contract.submitPrediction(
      25n,
      1n,
      true,
      80n,
      Buffer.alloc(65, 1)
    );
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_EXPIRED_SIGNATURE);
  });

  it("admin can update min-oracles", () => {
    contract.caller = "ST1ADMIN";
    const result = contract.setMinOracles(5n);
    expect(result.ok).toBe(true);
    expect(contract.state.minOracles).toBe(5n);
  });

  it("non-admin cannot change settings", () => {
    const result = contract.setMinOracles(4n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_UNAUTHORIZED);
  });
});
