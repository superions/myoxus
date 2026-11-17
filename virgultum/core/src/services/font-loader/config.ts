import { z } from "zod";

export const fontConfigSchema = z.object({
  font: z.string(),
  weight: z.string(),
  url: z.string(),
  style: z.string(),
});

export type FontConfig = z.infer<typeof fontConfigSchema>;
