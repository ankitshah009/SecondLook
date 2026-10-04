import { z } from "zod";

export const screenshotRequestSchema = z.object({
  image: z.string().max(2_900_000),
  url: z.string().url().max(2_000),
});
export const screenshotOutputSchema = z.object({
  findings: z.array(z.object({
    field: z.string().min(1).max(160), value: z.string().min(1).max(300),
    passage: z.string().min(1).max(2_000), subject: z.string().min(1).max(200),
  })).max(12),
});

export function validateScreenshot(input: unknown) {
  const parsed = screenshotRequestSchema.parse(input);
  const source = new URL(parsed.url);
  if (!["http:", "https:"].includes(source.protocol) || source.username || source.password) {
    throw new Error("Use an HTTP or HTTPS offer URL without embedded credentials.");
  }
  const match = parsed.image.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2].length % 4 !== 0) throw new Error("Choose a PNG, JPEG or WebP image.");
  const data = Buffer.from(match[2], "base64");
  if (data.length > 2 * 1024 * 1024 || data.length < 12) throw new Error("Choose an image no larger than 2 MB.");
  const isPng = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = data[0] === 255 && data[1] === 216 && data[2] === 255;
  const isWebp = data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
  if (!((match[1] === "image/png" && isPng) || (match[1] === "image/jpeg" && isJpeg) || (match[1] === "image/webp" && isWebp))) {
    throw new Error("The file contents do not match a supported image format.");
  }
  return { data, mediaType: match[1], url: source.href };
}
