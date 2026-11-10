import { createWorker, OEM, type Worker } from "tesseract.js";

export async function recognizeImage(image: string): Promise<string> {
  const assets = new URL("./ocr/", document.baseURI);
  let worker: Worker | undefined;
  let expired = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    let rejectWorker: (reason: unknown) => void;
    const failed = new Promise<never>((_, reject) => { rejectWorker = reject; });
    const run = async () => {
      const created = await createWorker(["chi_sim", "eng"], OEM.LSTM_ONLY, {
        workerPath: new URL("worker.min.js", assets).href,
        corePath: new URL("core/", assets).href,
        langPath: new URL("lang/", assets).href,
        workerBlobURL: false,
        cacheMethod: "none",
        errorHandler: error => rejectWorker(new Error(String(error))),
      });
      if (expired) {
        await created.terminate();
        return "";
      }
      worker = created;
      const text = (await worker.recognize(image)).data.text;
      // OCR may insert a space between two Chinese words on the same line. Keep
      // line breaks and indentation so the text remains readable and searchable.
      if (!text.trim()) return "";
      return text.replace(/(\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, "$1").replace(/[\r\n]+$/, "");
    };
    return await Promise.race([
      run(),
      failed,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("识别超时，请重试。")), 90_000);
      }),
    ]);
  } finally {
    expired = true;
    clearTimeout(timeout);
    await worker?.terminate();
  }
}
