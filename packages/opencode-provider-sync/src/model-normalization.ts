import type { ModelDiff, NormalizedModel, RawModel } from "./types.js";

const TOKEN_OVERRIDES: Record<string, string> = {
  ai: "AI",
  api: "API",
  cpu: "CPU",
  gpu: "GPU",
  glm: "GLM",
  gpt: "GPT",
  llm: "LLM",
  nlp: "NLP",
  ocr: "OCR",
  tts: "TTS",
  stt: "STT"
};

function titleCase(token: string): string {
  if (token.length === 0) {
    return token;
  }
  return token[0].toUpperCase() + token.slice(1).toLowerCase();
}

function normalizeToken(token: string): string {
  const lower = token.toLowerCase();

  if (TOKEN_OVERRIDES[lower]) {
    return TOKEN_OVERRIDES[lower];
  }

  if (/^\d+$/.test(token)) {
    return token;
  }

  if (/^\d+[a-z]$/i.test(token)) {
    const suffix = token.at(-1)?.toLowerCase() ?? "";
    if (["b", "k", "m", "g", "t"].includes(suffix)) {
      return `${token.slice(0, -1)}${suffix.toUpperCase()}`;
    }

    return `${token.slice(0, -1)}${suffix}`;
  }

  if (/^[a-z]+\d+[a-z0-9]*$/i.test(token)) {
    return token[0].toUpperCase() + token.slice(1).toLowerCase();
  }

  if (/^\d+[a-z]+$/i.test(token)) {
    return `${token.match(/^\d+/)?.[0] ?? ""}${token.replace(/^\d+/, "").toLowerCase()}`;
  }

  return titleCase(token);
}

export function normalizeModelId(modelId: string, overrides?: Record<string, string>): string {
  if (overrides?.[modelId]) {
    return overrides[modelId];
  }

  const normalizedTokens = modelId
    .split(/[-_/:]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => normalizeToken(token));

  if (normalizedTokens.length === 0) {
    return modelId;
  }

  return normalizedTokens.join(" ");
}

export function normalizeModelList(
  models: RawModel[],
  overrides?: Record<string, string>
): NormalizedModel[] {
  return models.map((model) => ({
    id: model.id,
    displayName: normalizeModelId(model.id, overrides)
  }));
}

export function diffModels(previous: NormalizedModel[], next: NormalizedModel[]): ModelDiff {
  const previousMap = new Map(previous.map((model) => [model.id, model.displayName]));
  const nextMap = new Map(next.map((model) => [model.id, model.displayName]));

  const added: string[] = [];
  const removed: string[] = [];
  const renamed: Array<{
    id: string;
    before: string;
    after: string;
  }> = [];

  for (const [id, displayName] of nextMap.entries()) {
    if (!previousMap.has(id)) {
      added.push(id);
      continue;
    }

    const previousName = previousMap.get(id);
    if (previousName && previousName !== displayName) {
      renamed.push({ id, before: previousName, after: displayName });
    }
  }

  for (const id of previousMap.keys()) {
    if (!nextMap.has(id)) {
      removed.push(id);
    }
  }

  return { added, removed, renamed };
}
