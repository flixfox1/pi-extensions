import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const vertexModelDefaults = {
  api: "google-vertex" as const,
  input: ["text", "image"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export default function (pi: ExtensionAPI) {
  // Keep the Google Vertex model selector clean for this account/project.
  // Verified working on 2026-04-24 with GOOGLE_CLOUD_LOCATION=global.
  // Hidden because they returned 404 for this project/location:
  // - gemini-1.5-flash
  // - gemini-1.5-flash-8b
  // - gemini-1.5-pro
  // - gemini-2.0-flash
  // - gemini-2.0-flash-lite
  // - gemini-3-pro-preview
  // Also hidden by preference: gemini-3.1-pro-preview-customtools.
  pi.registerProvider("google-vertex", {
    baseUrl: "https://{location}-aiplatform.googleapis.com",
    apiKey: "gcp-vertex-credentials",
    api: "google-vertex",
    models: [
      {
        ...vertexModelDefaults,
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash (Vertex, global)",
        reasoning: true,
        contextWindow: 1048576,
        maxTokens: 65536,
        cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
      },
      {
        ...vertexModelDefaults,
        id: "gemini-2.5-flash-lite",
        name: "Gemini 2.5 Flash Lite (Vertex, global)",
        reasoning: true,
        contextWindow: 1048576,
        maxTokens: 65536,
        cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
      },
      {
        ...vertexModelDefaults,
        id: "gemini-2.5-flash-lite-preview-09-2025",
        name: "Gemini 2.5 Flash Lite Preview 09-25 (Vertex, global)",
        reasoning: true,
        contextWindow: 1048576,
        maxTokens: 65536,
        cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
      },
      {
        ...vertexModelDefaults,
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro (Vertex, global)",
        reasoning: true,
        contextWindow: 1048576,
        maxTokens: 65536,
        cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
      },
      {
        ...vertexModelDefaults,
        id: "gemini-3-flash-preview",
        name: "Gemini 3 Flash Preview (Vertex, global)",
        reasoning: true,
        contextWindow: 1048576,
        maxTokens: 65536,
        cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
      },
      {
        ...vertexModelDefaults,
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview (Vertex, global)",
        reasoning: true,
        contextWindow: 1048576,
        maxTokens: 65536,
        cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
      },
    ],
  });
}
