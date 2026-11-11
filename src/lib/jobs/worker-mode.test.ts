import { describe, expect, it } from "vitest";
import { workerMode } from "./worker";

describe("workerMode", () => {
  it("is a timer by default, so servers that keep their CPU poll", () => {
    expect(workerMode({})).toBe("timer");
  });

  it("is inline on AWS Lambda and on Cloud Run (K_SERVICE), where nothing runs between requests", () => {
    expect(workerMode({ AWS_LAMBDA_FUNCTION_NAME: "fn" })).toBe("inline");
    expect(workerMode({ K_SERVICE: "helpdesk" })).toBe("inline");
  });

  it("an explicit JOBS_WORKER always wins over the platform", () => {
    expect(workerMode({ K_SERVICE: "helpdesk", JOBS_WORKER: "timer" })).toBe("timer");
    expect(workerMode({ K_SERVICE: "helpdesk", JOBS_WORKER: "off" })).toBe("off");
    expect(workerMode({ JOBS_WORKER: "inline" })).toBe("inline");
  });

  it("ignores an empty K_SERVICE and an unknown JOBS_WORKER", () => {
    expect(workerMode({ K_SERVICE: "" })).toBe("timer");
    expect(workerMode({ JOBS_WORKER: "garbage" })).toBe("timer");
  });
});
