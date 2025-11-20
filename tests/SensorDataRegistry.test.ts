import { describe, it, expect, beforeEach } from "vitest";
import {
  buffCV,
  uintCV,
  stringAsciiCV,
  tupleCV,
  listCV,
} from "@stacks/transactions";

const ERR_UNAUTHORIZED = 100;
const ERR_INVALID_HASH = 101;
const ERR_DUPLICATE_DATA = 102;
const ERR_DATA_NOT_FOUND = 103;
const ERR_INVALID_DEVICE = 104;
const ERR_INVALID_METADATA = 105;
const ERR_INVALID_TIMESTAMP = 106;
const ERR_MAX_DATA_EXCEEDED = 107;
const ERR_DEVICE_NOT_REGISTERED = 108;
const ERR_HASH_MISMATCH = 109;

interface SensorData {
  "data-hash": Buffer;
  "device-id": string;
  timestamp: bigint;
  metadata: string;
  "block-height": bigint;
  sequence: bigint;
}

interface DeviceInfo {
  "registered-at": bigint;
  "data-count": bigint;
  "last-sequence": bigint;
  "is-active": boolean;
}

interface Result<T> {
  ok: boolean;
  value: T | number;
}

class SensorDataRegistryMock {
  state: {
    nextDataId: bigint;
    maxDataEntries: bigint;
    admin: string;
    sensorData: Map<bigint, SensorData>;
    deviceRegistry: Map<string, DeviceInfo>;
    dataByDevice: Map<string, bigint>;
    dataByHash: Map<string, bigint>;
  } = {
    nextDataId: 0n,
    maxDataEntries: 1000000n,
    admin: "ST1ADMIN",
    sensorData: new Map(),
    deviceRegistry: new Map(),
    dataByDevice: new Map(),
    dataByHash: new Map(),
  };

  blockHeight: bigint = 100n;
  caller: string = "ST1DEVICE";

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      nextDataId: 0n,
      maxDataEntries: 1000000n,
      admin: "ST1ADMIN",
      sensorData: new Map(),
      deviceRegistry: new Map(),
      dataByDevice: new Map(),
      dataByHash: new Map(),
    };
    this.blockHeight = 100n;
    this.caller = "ST1DEVICE";
  }

  getDataEntry(id: bigint): SensorData | null {
    return this.state.sensorData.get(id) || null;
  }

  getDataByHash(hash: Buffer): bigint | null {
    return this.state.dataByHash.get(hash.toString("hex")) || null;
  }

  getDeviceInfo(device: string): DeviceInfo | null {
    return this.state.deviceRegistry.get(device) || null;
  }

  verifyDataIntegrity(id: bigint, expectedHash: Buffer): boolean {
    const entry = this.state.sensorData.get(id);
    return entry
      ? Buffer.compare(entry["data-hash"], expectedHash) === 0
      : false;
  }

  isDataUnique(hash: Buffer): boolean {
    return !this.state.dataByHash.has(hash.toString("hex"));
  }

  getLatestSequence(device: string): bigint {
    const info = this.state.deviceRegistry.get(device);
    return info ? info["last-sequence"] : 0n;
  }

  registerDevice(): Result<boolean> {
    const device = this.caller;
    if (this.state.deviceRegistry.has(device)) {
      return { ok: false, value: ERR_DUPLICATE_DATA };
    }
    this.state.deviceRegistry.set(device, {
      "registered-at": this.blockHeight,
      "data-count": 0n,
      "last-sequence": 0n,
      "is-active": true,
    });
    return { ok: true, value: true };
  }

  deactivateDevice(device: string): Result<boolean> {
    if (this.caller !== this.state.admin) {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }
    const info = this.state.deviceRegistry.get(device);
    if (!info) {
      return { ok: false, value: ERR_DEVICE_NOT_REGISTERED };
    }
    this.state.deviceRegistry.set(device, { ...info, "is-active": false });
    return { ok: true, value: true };
  }

  setAdmin(newAdmin: string): Result<boolean> {
    if (this.caller !== this.state.admin) {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }
    this.state.admin = newAdmin;
    return { ok: true, value: true };
  }

  registerSensorData(
    dataHash: Buffer,
    deviceId: string,
    metadata: string,
    sequence: bigint
  ): Result<bigint> {
    if (this.state.nextDataId >= this.state.maxDataEntries) {
      return { ok: false, value: ERR_MAX_DATA_EXCEEDED };
    }
    if (dataHash.length !== 32) {
      return { ok: false, value: ERR_INVALID_HASH };
    }
    if (metadata.length > 256) {
      return { ok: false, value: ERR_INVALID_METADATA };
    }
    if (this.caller !== deviceId) {
      return { ok: false, value: ERR_UNAUTHORIZED };
    }
    const deviceInfo = this.state.deviceRegistry.get(deviceId);
    if (!deviceInfo || !deviceInfo["is-active"]) {
      return { ok: false, value: ERR_DEVICE_NOT_REGISTERED };
    }
    if (sequence !== deviceInfo["last-sequence"] + 1n) {
      return { ok: false, value: ERR_INVALID_TIMESTAMP };
    }
    const hashKey = dataHash.toString("hex");
    if (this.state.dataByHash.has(hashKey)) {
      return { ok: false, value: ERR_DUPLICATE_DATA };
    }

    const newId = this.state.nextDataId;
    const entry: SensorData = {
      "data-hash": dataHash,
      "device-id": deviceId,
      timestamp: this.blockHeight,
      metadata,
      "block-height": this.blockHeight,
      sequence,
    };
    this.state.sensorData.set(newId, entry);
    this.state.dataByHash.set(hashKey, newId);
    this.state.dataByDevice.set(`${deviceId}-${sequence}`, newId);

    this.state.deviceRegistry.set(deviceId, {
      ...deviceInfo,
      "data-count": deviceInfo["data-count"] + 1n,
      "last-sequence": sequence,
    });

    this.state.nextDataId += 1n;
    return { ok: true, value: newId };
  }

  batchRegisterData(
    entries: Array<{
      hash: Buffer;
      device: string;
      metadata: string;
      sequence: bigint;
    }>
  ): Result<bigint[]> {
    const results: bigint[] = [];
    for (const entry of entries) {
      const result = this.registerSensorData(
        entry.hash,
        entry.device,
        entry.metadata,
        entry.sequence
      );
      if (!result.ok) {
        return { ok: false, value: result.value as number };
      }
      results.push(result.value as bigint);
    }
    return { ok: true, value: results };
  }

  getDeviceDataRange(
    device: string,
    start: bigint,
    end: bigint
  ): (bigint | null)[] {
    const range = Array.from({ length: 10 }, (_, i) => start + BigInt(i));
    return range
      .filter((seq) => seq >= start && seq <= end)
      .map((seq) => this.state.dataByDevice.get(`${device}-${seq}`) || null);
  }
}

describe("SensorDataRegistry", () => {
  let contract: SensorDataRegistryMock;

  beforeEach(() => {
    contract = new SensorDataRegistryMock();
    contract.reset();
  });

  it("registers a device successfully", () => {
    const result = contract.registerDevice();
    expect(result.ok).toBe(true);
    const info = contract.getDeviceInfo("ST1DEVICE");
    expect(info?.["is-active"]).toBe(true);
    expect(info?.["last-sequence"]).toBe(0n);
  });

  it("rejects duplicate device registration", () => {
    contract.registerDevice();
    const result = contract.registerDevice();
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_DUPLICATE_DATA);
  });

  it("registers sensor data with valid sequence", () => {
    contract.registerDevice();
    const hash = Buffer.from("a".repeat(64), "hex");
    const result = contract.registerSensorData(
      hash,
      "ST1DEVICE",
      "temp:25.5",
      1n
    );
    expect(result.ok).toBe(true);
    expect(result.value).toBe(0n);
    const entry = contract.getDataEntry(0n);
    expect(entry?.["data-hash"].toString("hex")).toBe(hash.toString("hex"));
    expect(entry?.sequence).toBe(1n);
    expect(entry?.metadata).toBe("temp:25.5");
  });

  it("rejects data with invalid hash length", () => {
    contract.registerDevice();
    const invalidHash = Buffer.from("abc", "hex");
    const result = contract.registerSensorData(
      invalidHash,
      "ST1DEVICE",
      "data",
      1n
    );
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_HASH);
  });

  it("rejects data from unauthorized caller", () => {
    contract.registerDevice();
    contract.caller = "ST2HACKER";
    const hash = Buffer.from("a".repeat(64), "hex");
    const result = contract.registerSensorData(hash, "ST1DEVICE", "data", 1n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_UNAUTHORIZED);
  });

  it("rejects data for unregistered or inactive device", () => {
    const hash = Buffer.from("a".repeat(64), "hex");
    const result = contract.registerSensorData(hash, "ST1DEVICE", "data", 1n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_DEVICE_NOT_REGISTERED);
  });

  it("enforces sequence order", () => {
    contract.registerDevice();
    const hash1 = Buffer.from("a".repeat(64), "hex");
    const hash2 = Buffer.from("b".repeat(64), "hex");
    contract.registerSensorData(hash1, "ST1DEVICE", "first", 1n);
    const result = contract.registerSensorData(hash2, "ST1DEVICE", "third", 3n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_TIMESTAMP);
  });

  it("prevents duplicate data by hash", () => {
    contract.registerDevice();
    const hash = Buffer.from("a".repeat(64), "hex");
    contract.registerSensorData(hash, "ST1DEVICE", "first", 1n);
    const result = contract.registerSensorData(hash, "ST1DEVICE", "again", 2n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_DUPLICATE_DATA);
  });

  it("verifies data integrity correctly", () => {
    contract.registerDevice();
    const hash = Buffer.from("a".repeat(64), "hex");
    contract.registerSensorData(hash, "ST1DEVICE", "data", 1n);
    const valid = contract.verifyDataIntegrity(0n, hash);
    expect(valid).toBe(true);
    const wrongHash = Buffer.from("b".repeat(64), "hex");
    const invalid = contract.verifyDataIntegrity(0n, wrongHash);
    expect(invalid).toBe(false);
  });

  it("deactivates device as admin", () => {
    contract.registerDevice();
    contract.caller = "ST1ADMIN";
    const result = contract.deactivateDevice("ST1DEVICE");
    expect(result.ok).toBe(true);
    const info = contract.getDeviceInfo("ST1DEVICE");
    expect(info?.["is-active"]).toBe(false);
  });

  it("rejects deactivation by non-admin", () => {
    contract.registerDevice();
    const result = contract.deactivateDevice("ST1DEVICE");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_UNAUTHORIZED);
  });

  it("changes admin successfully", () => {
    contract.caller = "ST1ADMIN";
    const result = contract.setAdmin("ST2NEWADMIN");
    expect(result.ok).toBe(true);
    expect(contract.state.admin).toBe("ST2NEWADMIN");
  });

  it("batch registers multiple data entries", () => {
    contract.registerDevice();
    const entries = [
      {
        hash: Buffer.from("a".repeat(64), "hex"),
        device: "ST1DEVICE",
        metadata: "t:25",
        sequence: 1n,
      },
      {
        hash: Buffer.from("b".repeat(64), "hex"),
        device: "ST1DEVICE",
        metadata: "t:26",
        sequence: 2n,
      },
    ];
    const result = contract.batchRegisterData(entries);
    expect(result.ok).toBe(true);
    expect(result.value as bigint[]).toEqual([0n, 1n]);
  });

  it("respects max data entries limit", () => {
    contract.state.nextDataId = 999999n;
    contract.state.maxDataEntries = 1000000n;
    contract.registerDevice();
    const hash = Buffer.from("a".repeat(64), "hex");
    const result = contract.registerSensorData(hash, "ST1DEVICE", "last", 1n);
    expect(result.ok).toBe(true);
    contract.state.nextDataId = 1000000n;
    const overflow = contract.registerSensorData(hash, "ST1DEVICE", "over", 2n);
    expect(overflow.ok).toBe(false);
    expect(overflow.value).toBe(ERR_MAX_DATA_EXCEEDED);
  });

  it("returns total data count accurately", () => {
    contract.registerDevice();
    contract.registerSensorData(
      Buffer.from("a".repeat(64), "hex"),
      "ST1DEVICE",
      "d1",
      1n
    );
    contract.registerSensorData(
      Buffer.from("b".repeat(64), "hex"),
      "ST1DEVICE",
      "d2",
      2n
    );
    expect(contract.state.nextDataId).toBe(2n);
  });
});
