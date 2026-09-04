import { describe, expect, it } from "vitest";

import { diffModels, normalizeModelId, normalizeModelList } from "../src/model-normalization.js";

describe("normalizeModelId", () => {
  it("normalizes IDs into readable names", () => {
    expect(normalizeModelId("glm-5")).toBe("GLM 5");
    expect(normalizeModelId("gpt-4o-mini")).toBe("GPT 4o Mini");
    expect(normalizeModelId("qwen2-72b-instruct")).toBe("Qwen2 72B Instruct");
  });

  it("applies explicit model name overrides", () => {
    expect(normalizeModelId("glm-5", { "glm-5": "GLM 5" })).toBe("GLM 5");
  });
});

describe("normalizeModelList and diffModels", () => {
  it("generates deterministic model diffs", () => {
    const previous = normalizeModelList([{ id: "glm-5" }, { id: "legacy-model" }]);

    const next = normalizeModelList(
      [{ id: "glm-5" }, { id: "qwen2-72b-instruct" }, { id: "legacy-model" }],
      { "legacy-model": "Legacy Model (Renamed)" }
    );

    const diff = diffModels(previous, next);

    expect(diff.added).toEqual(["qwen2-72b-instruct"]);
    expect(diff.removed).toEqual([]);
    expect(diff.renamed).toEqual([
      {
        id: "legacy-model",
        before: "Legacy Model",
        after: "Legacy Model (Renamed)"
      }
    ]);
  });
});
