import { expect, test, vi } from "vitest";
import { recognizeImage } from "./ocr.ts";

const { recognize } = vi.hoisted(() => ({ recognize: vi.fn() }));
vi.mock("tesseract.js", () => ({
  createWorker: async () => ({ recognize, terminate: async () => {} }),
  OEM: { LSTM_ONLY: 1 },
}));

test("recognition preserves indentation and treats whitespace-only results as empty", async () => {
  recognize
    .mockResolvedValueOnce({ data: { text: "    return x\n    下一 行\r\n\n" } })
    .mockResolvedValueOnce({ data: { text: "  \n\t" } });
  await expect(recognizeImage("image")).resolves.toBe("    return x\n    下一行");
  await expect(recognizeImage("empty image")).resolves.toBe("");
});
