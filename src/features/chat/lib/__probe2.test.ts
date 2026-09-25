import { it } from "vitest";
import { classifyRequest } from "./task-complexity";

it("times classifyRequest on the 100KB input", () => {
  const big = "x".repeat(100_000);
  const t0 = performance.now();
  classifyRequest({ text: big });
  console.log("100KB classify ms:", Math.round(performance.now() - t0));
});
