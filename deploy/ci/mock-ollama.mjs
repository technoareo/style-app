// Mock Ollama for the Docker CI job ONLY. It answers just enough of the API
// for Style Studio's worker: /api/tags (the model is "installed") and
// /api/chat (one fixed garment). No model, no inference, no network access.
import { createServer } from "node:http";

const answer = JSON.stringify({
  message: {
    content: JSON.stringify({
      items: [
        {
          name: "White shirt",
          category: "Tops",
          color: "white",
          pattern: "solid",
          formality: "casual",
          brand: "",
          size: "",
          confidence: 0.75,
          evidence: "Short sleeves visible",
          box: [100, 100, 900, 900],
        },
      ],
      warning: "",
    }),
  },
});

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/tags") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ models: [{ name: "qwen3-vl:4b-instruct" }] }));
    return;
  }
  if (req.method === "POST" && req.url === "/api/chat") {
    req.resume();
    req.on("end", () => {
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(answer);
      }, 300);
    });
    return;
  }
  res.statusCode = 404;
  res.end("{}");
}).listen(11434, "0.0.0.0");
